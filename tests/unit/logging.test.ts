import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/logging/logger";
import { redact } from "../../src/logging/redaction";

describe("redaction and ordinary logs", () => {
  test("redacts secret keys recursively without mutating the caller", () => {
    const input = {
      safe: "metadata",
      AuthORization: "fixture-authorization",
      nested: [{ access_token: "fixture-access", SESSION_ID: "fixture-session" }],
      cookies: [{ name: "session", value: "fixture-cookie" }],
      localStorage: { auth: "fixture-storage" },
    };
    const serialized = JSON.stringify(redact(input));
    for (const secret of [
      "fixture-authorization",
      "fixture-access",
      "fixture-session",
      "fixture-cookie",
      "fixture-storage",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("metadata");
    expect(input.nested[0].access_token).toBe("fixture-access");
  });

  test("redacts known secrets in strings, arrays and encoded URLs", () => {
    const secret = "r0:fixture-token";
    const result = JSON.stringify(
      redact(
        {
          values: [
            secret,
            `https://example.invalid/bot${secret}/getMe`,
            encodeURIComponent(secret),
          ],
        },
        [secret],
      ),
    );
    expect(result).not.toContain(secret);
    expect(result).not.toContain(encodeURIComponent(secret));
  });

  test("redacts recognizable authorization and cookie header values", () => {
    const result = JSON.stringify(
      redact({
        values: [
          "Authorization: Bearer fixture-auth",
          "Basic fixture-basic",
          "Cookie: session=fixture-cookie",
          "Set-Cookie: session=fixture-set-cookie",
        ],
      }),
    );
    for (const value of ["fixture-auth", "fixture-basic", "fixture-cookie", "fixture-set-cookie"]) {
      expect(result).not.toContain(value);
    }
  });

  test("serializes correlation fields after redaction and discards arbitrary content", () => {
    const lines: string[] = [];
    const log = createLogger({
      knownSecrets: ["r0-fixture-token"],
      sink: (line) => lines.push(line),
    });
    const fields = {
      operation: "fixture.completed",
      requestId: "request-fixture",
      telegramUpdateId: "update-fixture",
      telegramUserId: "user-fixture",
      conversationId: "conversation-fixture",
      conversationAlias: "alias r0-fixture-token",
      durationMs: 12,
      prompt: "fixture-private-prompt",
      response: "fixture-private-response",
      error: new Error("fixture-private-error r0-fixture-token"),
      config: { cookies: "fixture-private-cookies" },
      issues: [{ field: "LOG_LEVEL", reason: "invalid r0-fixture-token" }],
    };
    log("info", fields);
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    const record = JSON.parse(lines[0]);
    expect(record.level).toBe("info");
    expect(record.timestamp).toMatch(/Z$/);
    expect(record.requestId).toBe("request-fixture");
    expect(record.conversationId).toBe("conversation-fixture");
    expect(record.durationMs).toBe(12);
    expect(record.prompt).toBeUndefined();
    expect(record.response).toBeUndefined();
    for (const secret of [
      "r0-fixture-token",
      "fixture-private-prompt",
      "fixture-private-response",
      "fixture-private-error",
      "fixture-private-cookies",
    ]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  test("filters levels before writing and escapes newlines in values", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", sink: (line) => lines.push(line) });
    log("info", { operation: "fixture.quiet" });
    log("error", { operation: "fixture.failed", conversationAlias: "line one\nline two" });
    expect(lines).toHaveLength(1);
    expect(lines[0].split("\n")).toHaveLength(2);
  });
});
