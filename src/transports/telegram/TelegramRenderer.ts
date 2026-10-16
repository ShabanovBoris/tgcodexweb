export type TelegramChunk = Readonly<{ html: string; plain: string }>;
type Block = Readonly<{ text: string; code: boolean }>;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function blocks(text: string): Block[] {
  const result: Block[] = [];
  let offset = 0;
  const fences = /^(?:`{3,}|~{3,})[^\n]*\n/gm;
  for (let match = fences.exec(text); match; match = fences.exec(text)) {
    if (match.index < offset) continue;
    if (match.index > offset) result.push({ text: text.slice(offset, match.index), code: false });
    const marker = /^[`~]+/.exec(match[0])?.[0] as string;
    const end = new RegExp(`^${marker[0]}{${marker.length},}[ \\t]*(?:\\n|$)`, "gm");
    end.lastIndex = fences.lastIndex;
    const closing = end.exec(text);
    const finish = closing ? end.lastIndex : text.length;
    result.push({ text: text.slice(match.index, finish), code: true });
    offset = finish;
    fences.lastIndex = finish;
  }
  if (offset < text.length) result.push({ text: text.slice(offset), code: false });
  return result;
}

function boundary(text: string, limit: number): number {
  let end = Math.min(text.length, limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const prefix = text.slice(0, end);
  for (const pattern of [/\n(?=#{1,6} )/g, /\n\n/g, /\n/g, /[.!?] /g, / /g]) {
    let candidate = 0;
    for (const match of prefix.matchAll(pattern)) candidate = (match.index ?? 0) + match[0].length;
    if (candidate >= end / 2) return candidate;
  }
  return end;
}

// Keep the source text intact. Only fences receive pre formatting; arbitrary provider HTML is escaped.
// Counting UTF-16 units is conservative for Telegram's 4096 characters and preserves surrogate pairs.
export function renderTelegram(text: string, limit = 4096): TelegramChunk[] {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 4096)
    throw new Error("INVALID_CHUNK_LIMIT");
  const chunks: TelegramChunk[] = [];
  let plain = "",
    html = "";
  const flush = () => {
    if (plain) chunks.push({ plain, html });
    plain = "";
    html = "";
  };
  for (const block of blocks(text)) {
    if (block.text.length <= limit && plain.length + block.text.length > limit) flush();
    let remaining = block.text;
    while (remaining) {
      if (plain.length === limit) flush();
      const end =
        remaining.length <= limit - plain.length
          ? remaining.length
          : boundary(remaining, limit - plain.length);
      if (end === 0) {
        flush();
        continue;
      }
      const part = remaining.slice(0, end);
      plain += part;
      html += block.code ? `<pre>${escapeHtml(part)}</pre>` : escapeHtml(part);
      remaining = remaining.slice(end);
      if (remaining) flush();
    }
  }
  flush();
  return chunks;
}
