import { expect, test } from "bun:test";
import { parseTelegramCommand, telegramHelp } from "../../src/transports/telegram/TelegramCommands";

test("required commands have explicit arity, aliases and references are passed without rewriting", () => {
  for (const [text, name, args] of [
    ["/start", "start", []],
    ["/help", "help", []],
    ["/new", "new", []],
    ["/new coding", "new", ["coding"]],
    ["/add Code https://chatgpt.com/c/example", "add", ["Code", "https://chatgpt.com/c/example"]],
    ["/chats", "chats", []],
    ["/use Code", "use", ["Code"]],
    ["/current", "current", []],
    ["/rename Code New", "rename", ["Code", "New"]],
    ["/remove New", "remove", ["New"]],
    ["/status", "status", []],
    ["/stop", "stop", []],
  ] as const) {
    expect(parseTelegramCommand(text, "r4_bot")).toEqual({
      kind: "command",
      name,
      args: [...args],
    });
    expect(telegramHelp).toContain(`/${name}`);
  }
});

test("bot-qualified commands match this bot only; malformed or extra arguments never become prompts", () => {
  expect(parseTelegramCommand("/new@R4_BOT coding", "r4_bot")).toEqual({
    kind: "command",
    name: "new",
    args: ["coding"],
  });
  expect(parseTelegramCommand("/new@another_bot coding", "r4_bot")).toEqual({ kind: "ignored" });
  for (const text of [
    "/",
    "/new a b",
    "/add a",
    "/add a b c",
    "/use",
    "/rename old",
    "/remove",
    "/status extra",
    "/unknown",
    "/help!",
    "/constructor",
  ])
    expect(parseTelegramCommand(text, "r4_bot")).toEqual({ kind: "invalid" });
  expect(parseTelegramCommand("  exact prompt\n", "r4_bot")).toEqual({ kind: "text" });
});
