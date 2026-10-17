import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ProviderOperationError } from "../../ports/ChatProvider";

export const remoteIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const registrySchema = z.strictObject({
  version: z.literal(1),
  conversations: z.array(
    z.strictObject({
      key: z.string().regex(/^(pending|chatgpt):[0-9a-f-]{36}$/),
      remoteId: z.string().regex(remoteIdPattern).optional(),
    }),
  ),
});
type Entry = z.infer<typeof registrySchema>["conversations"][number];
const owner = { owner: "tg-webgpt-gateway", version: 1 } as const;

// Browser credentials stay in this dedicated directory. This registry contains identity only.
export class BrowserProfile {
  readonly directory: string;
  private entries: Entry[] | undefined;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  initialize(refresh = false): void {
    if (this.entries && !refresh) return;
    try {
      if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.directory).isDirectory()) throw new Error();
      const marker = join(this.directory, "gateway-profile.json");
      if (!existsSync(marker)) {
        if (readdirSync(this.directory).length !== 0) throw new Error();
        this.atomicWrite("gateway-profile.json", owner);
      }
      const proof = this.readJson(marker);
      if (
        !z.strictObject({ owner: z.literal(owner.owner), version: z.literal(1) }).safeParse(proof)
          .success
      )
        throw new Error();
      chmodSync(this.directory, 0o700);
      const file = join(this.directory, "gateway-conversations.json");
      const parsed = registrySchema.parse(
        existsSync(file) ? this.readJson(file) : { version: 1, conversations: [] },
      );
      const keys = parsed.conversations.map((entry) => entry.key);
      const remotes = parsed.conversations.flatMap((entry) =>
        entry.remoteId ? [entry.remoteId] : [],
      );
      if (new Set(keys).size !== keys.length || new Set(remotes).size !== remotes.length)
        throw new Error();
      for (const entry of parsed.conversations) {
        const suffix = entry.key.slice(entry.key.indexOf(":") + 1);
        if (
          !remoteIdPattern.test(suffix) ||
          (entry.key.startsWith("chatgpt:") && entry.remoteId !== suffix)
        )
          throw new Error();
      }
      this.entries = parsed.conversations;
    } catch {
      this.entries = undefined;
      throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    }
  }

  createDraft(): string {
    const key = `pending:${randomUUID()}`;
    this.persist([...this.all(), { key }]);
    return key;
  }

  keyForRemote(remoteId: string): string {
    if (!remoteIdPattern.test(remoteId))
      throw new ProviderOperationError("INVALID_CONVERSATION_REFERENCE");
    const existing = this.all().find((entry) => entry.remoteId === remoteId);
    if (existing) return existing.key;
    const key = `chatgpt:${remoteId}`;
    this.persist([...this.all(), { key, remoteId }]);
    return key;
  }

  remoteId(key: string): string | undefined {
    const entry = this.all().find((entry) => entry.key === key);
    if (!entry) throw new ProviderOperationError("CHAT_NOT_FOUND");
    return entry.remoteId;
  }

  bind(key: string, remoteId: string): void {
    const previous = this.remoteId(key);
    if (
      !remoteIdPattern.test(remoteId) ||
      (previous && previous !== remoteId) ||
      this.all().some((entry) => entry.remoteId === remoteId && entry.key !== key)
    )
      throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    if (previous === remoteId) return;
    this.persist(this.all().map((entry) => (entry.key === key ? { key, remoteId } : entry)));
  }

  private all(): Entry[] {
    if (!this.entries) throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    return this.entries;
  }
  private readJson(file: string): unknown {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error();
    return JSON.parse(readFileSync(file, "utf8"));
  }
  private persist(entries: Entry[]): void {
    try {
      this.atomicWrite("gateway-conversations.json", { version: 1, conversations: entries });
    } catch {
      this.entries = undefined;
      throw new ProviderOperationError("PROVIDER_UNAVAILABLE");
    }
    this.entries = entries;
  }
  private atomicWrite(name: string, value: unknown): void {
    const target = join(this.directory, name);
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error();
    const temp = join(this.directory, `.gateway-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
}
