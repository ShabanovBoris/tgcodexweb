import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolchain, ToolchainError } from "./check-toolchain";
import { ConfigError, loadBrowserConfig } from "../src/config/Config";
import { ProviderOperationError } from "../src/ports/ChatProvider";
import { BrowserProfile } from "../src/providers/chatgpt-web/BrowserProfile";
import { ChatGptWebProvider } from "../src/providers/chatgpt-web/ChatGptWebProvider";
import { LocalAttachmentStore } from "../src/storage/LocalAttachmentStore";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function syntheticPdf(): Buffer {
  const stream = "BT /F1 12 Tf 72 720 Td (TGWEBGPT_R6_PDF_OK) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const mode = process.argv[2] ?? "health";
// Opt-in is checked before profile/browser/filesystem effects. Normal verification never runs this.
if (
  process.env.TGWEBGPT_LIVE !== "1" ||
  !["health", "roundtrip"].includes(mode) ||
  (mode === "roundtrip" && process.env.TGWEBGPT_LIVE_SEND !== "1")
) {
  process.stderr.write(
    "LIVE_OPT_IN_REQUIRED: TGWEBGPT_LIVE=1; roundtrip additionally requires TGWEBGPT_LIVE_SEND=1.\n",
  );
  process.exitCode = 1;
} else {
  let provider: ChatGptWebProvider | undefined;
  let directory: string | undefined;
  try {
    checkToolchain();
    const browser = loadBrowserConfig(process.env);
    directory = mkdtempSync(join(tmpdir(), "tgwebgpt-r6-live-input-"));
    const store = new LocalAttachmentStore(directory);
    await store.initialize();
    provider = new ChatGptWebProvider({ ...browser, attachmentStore: store });
    const before = await provider.health();
    const receipt: Record<string, unknown> = {
      live: true,
      upstream: "fa2d2c6c24926078b46eedb2186f69f2e8d548d7",
      mode,
      before: before.state,
    };
    if (mode === "roundtrip") {
      if (before.state !== "ready")
        throw new ProviderOperationError(
          before.state === "auth_required" ? "AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
        );
      const conversation = await provider.createConversation();
      const text =
        "What is 2+2? Read the attached PDF and append its single marker. Reply with exactly the number, one space, and that marker.";
      const bytes = syntheticPdf();
      const stored = await store.put(
        (async function* () {
          yield bytes;
        })(),
        bytes.length,
      );
      stored.release();
      const submitted = await provider.send({
        conversationId: conversation.id,
        clientRequestId: randomUUID(),
        text,
        attachments: [
          {
            storageKey: stored.key,
            filename: "integration-check.pdf",
            mimeType: "application/pdf",
            sizeBytes: bytes.length,
          },
        ],
      });
      receipt.submission = submitted.state;
      receipt.promptSha256 = hash(text);
      if (submitted.state === "submitted") {
        const outcome = await provider.awaitCompletion({
          submission: submitted,
          signal: AbortSignal.timeout(600_000),
        });
        receipt.outcome = outcome.state;
        if (outcome.state === "completed") {
          receipt.answerSha256 = hash(outcome.message.text);
          receipt.answerCharacters = outcome.message.text.length;
          receipt.answerMatchesExpected = outcome.message.text.trim() === "4 TGWEBGPT_R6_PDF_OK";
        }
        const registry = new BrowserProfile(browser.profileDir);
        registry.initialize();
        const remote = registry.remoteId(conversation.id);
        receipt.sameCanonicalIdentity =
          !!remote && (await provider.inspectConversation(remote)).id === conversation.id;
        try {
          await provider.inspectConversation("00000000-0000-4000-8000-000000000000");
          receipt.inaccessibleRejected = false;
        } catch (error) {
          receipt.inaccessibleRejected =
            error instanceof ProviderOperationError &&
            ["CHAT_NOT_FOUND", "CHAT_ACCESS_DENIED"].includes(error.code);
        }
        if (
          outcome.state !== "completed" ||
          !receipt.answerMatchesExpected ||
          !receipt.sameCanonicalIdentity ||
          !receipt.inaccessibleRejected
        )
          process.exitCode = 1;
      } else process.exitCode = 1;
      await store.remove(stored.key);
    }
    await provider.close();
    provider = new ChatGptWebProvider(browser);
    receipt.afterRestart = (await provider.health()).state;
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (before.state !== "ready" || receipt.afterRestart !== "ready") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ live: true, errorCode: error instanceof ProviderOperationError || error instanceof ConfigError || error instanceof ToolchainError ? error.code : "PROVIDER_UNAVAILABLE" })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await provider?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
