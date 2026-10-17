import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProfile } from "../../src/providers/chatgpt-web/BrowserProfile";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tgwebgpt-r6-profile-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const remote = "6abce299-fdbc-83ed-9b04-7016343a6984";

test("dedicated profile is private, owned, and stores only durable conversation identity", () => {
  const directory = join(root, "profile");
  const profile = new BrowserProfile(directory);
  profile.initialize();
  const key = profile.createDraft();
  expect(profile.remoteId(key)).toBeUndefined();
  profile.bind(key, remote);
  expect(profile.keyForRemote(remote)).toBe(key);
  const reopened = new BrowserProfile(directory);
  reopened.initialize();
  expect(reopened.remoteId(key)).toBe(remote);
  expect(reopened.keyForRemote(remote)).toBe(key);
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(directory, "gateway-conversations.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(directory, "gateway-conversations.json"), "utf8"))).toEqual({
    version: 1,
    conversations: [{ key, remoteId: remote }],
  });
});

test("existing remote aliases converge across restart; identity never silently changes", () => {
  const profile = new BrowserProfile(join(root, "profile"));
  profile.initialize();
  const key = profile.keyForRemote(remote);
  expect(profile.keyForRemote(remote)).toBe(key);
  const draft = profile.createDraft();
  expect(() => profile.bind(draft, remote)).toThrow("PROVIDER_UNAVAILABLE");
  expect(() => profile.bind(key, "00000000-0000-0000-0000-000000000000")).toThrow(
    "PROVIDER_UNAVAILABLE",
  );
  expect(profile.remoteId(draft)).toBeUndefined();
  expect(() => profile.remoteId("unknown")).toThrow("CHAT_NOT_FOUND");
});

test("foreign profiles and symlink roots/metadata are rejected without reading browser state", () => {
  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "Cookies"), "synthetic-private-content");
  expect(() => new BrowserProfile(foreign).initialize()).toThrow("PROVIDER_UNAVAILABLE");
  expect(readdirSync(foreign)).toEqual(["Cookies"]);
  const link = join(root, "linked");
  symlinkSync(foreign, link);
  expect(() => new BrowserProfile(link).initialize()).toThrow("PROVIDER_UNAVAILABLE");
  const owned = join(root, "owned");
  new BrowserProfile(owned).initialize();
  symlinkSync(join(foreign, "Cookies"), join(owned, "gateway-conversations.json"));
  expect(() => new BrowserProfile(owned).initialize()).toThrow("PROVIDER_UNAVAILABLE");
  expect(readFileSync(join(foreign, "Cookies"), "utf8")).toBe("synthetic-private-content");
});

test("malformed or duplicate persisted identity cannot create a second canonical key", () => {
  const directory = join(root, "profile");
  new BrowserProfile(directory).initialize();
  writeFileSync(
    join(directory, "gateway-conversations.json"),
    JSON.stringify({
      version: 1,
      conversations: [
        { key: `chatgpt:${remote}`, remoteId: remote },
        { key: `pending:${remote}`, remoteId: remote },
      ],
    }),
  );
  expect(() => new BrowserProfile(directory).initialize()).toThrow("PROVIDER_UNAVAILABLE");
  writeFileSync(
    join(directory, "gateway-conversations.json"),
    JSON.stringify({
      version: 1,
      conversations: [{ key: `chatgpt:00000000-0000-4000-8000-000000000000`, remoteId: remote }],
    }),
  );
  expect(() => new BrowserProfile(directory).initialize()).toThrow("PROVIDER_UNAVAILABLE");
});

test("refresh after browser ownership changes preserves the latest canonical binding", () => {
  const directory = join(root, "profile");
  const previous = new BrowserProfile(directory);
  previous.initialize();
  const cached = new BrowserProfile(directory);
  cached.initialize();
  const key = previous.createDraft();
  previous.bind(key, remote);
  cached.initialize(true);
  expect(cached.keyForRemote(remote)).toBe(key);
});
