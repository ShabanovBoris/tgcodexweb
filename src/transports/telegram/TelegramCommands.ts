export const telegramHelp = [
  "/start — состояние и команды",
  "/help — команды",
  "/new [alias] — создать и выбрать чат",
  "/add <alias> <url-or-id> — добавить и выбрать существующий чат",
  "/chats — список чатов",
  "/use <alias> — выбрать чат",
  "/current — выбранный чат",
  "/rename <old> <new> — переименовать",
  "/remove <alias> — убрать локальную привязку",
  "/status — состояние",
  "/stop — остановить текущую генерацию",
  "Обычный текст, включая reply, отправляется в выбранный чат. Файлы появятся в R5.",
].join("\n");

const arities: Record<string, readonly number[]> = {
  start: [0],
  help: [0],
  new: [0, 1],
  add: [2],
  chats: [0],
  use: [1],
  current: [0],
  rename: [2],
  remove: [1],
  status: [0],
  stop: [0],
};
export type ParsedCommand =
  | Readonly<{ kind: "text" | "ignored" | "invalid" }>
  | Readonly<{ kind: "command"; name: string; args: string[] }>;

export function parseTelegramCommand(text: string, username: string): ParsedCommand {
  if (!text.startsWith("/")) return { kind: "text" };
  const match = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { kind: "invalid" };
  if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return { kind: "ignored" };
  const name = match[1].toLowerCase();
  const args = match[3]?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!Object.hasOwn(arities, name) || !arities[name].includes(args.length))
    return { kind: "invalid" };
  return { kind: "command", name, args };
}
