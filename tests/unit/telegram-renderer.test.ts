import { expect, test } from "bun:test";
import { renderTelegram } from "../../src/transports/telegram/TelegramRenderer";

test("AC-I01 exact source and Unicode survive ordered chunking at Telegram limit", () => {
  for (const text of [
    "a".repeat(20000),
    "Привет 😀 e\u0301\n\n".repeat(2000),
    "<&>".repeat(5000),
    `${"a".repeat(4095)}😀end`,
  ]) {
    const chunks = renderTelegram(text);
    expect(chunks.map((c) => c.plain).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.plain.length).toBeLessThanOrEqual(4096);
      expect(chunk.plain.length).toBeGreaterThan(0);
      expect(chunk.plain).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  }
});

test("AC-I02 fenced blocks stay atomic when possible, split pre tags are balanced", () => {
  const small = "before\n```ts\nconst x = '<b>';\n```\nafter";
  const chunks = renderTelegram(small);
  expect(chunks.map((c) => c.plain).join("")).toBe(small);
  expect(chunks[0].html).toContain("<pre>```ts\nconst x = '&lt;b&gt;';\n```\n</pre>");
  const long = `header\n~~~text\n${"😀 <&>\n".repeat(2000)}~~~\nfooter`;
  for (const chunk of renderTelegram(long)) {
    expect((chunk.html.match(/<pre>/g) ?? []).length).toBe(
      (chunk.html.match(/<\/pre>/g) ?? []).length,
    );
    expect(chunk.plain.length).toBeLessThanOrEqual(4096);
  }
  expect(
    renderTelegram(long)
      .map((c) => c.plain)
      .join(""),
  ).toBe(long);
});

test("provider HTML and unmatched Markdown are literal safe text", () => {
  const text = "<script>bad</script> &quot; [link](javascript:bad) ** * _ `\n```lang\n<&>";
  const chunks = renderTelegram(text);
  expect(chunks.map((c) => c.plain).join("")).toBe(text);
  expect(chunks[0].html).not.toContain("<script>");
  expect(chunks[0].html).toContain("&amp;quot;");
  expect(chunks[0].html).not.toContain("href=");
});

test("paragraph boundaries are preferred without trimming and empty answer has no chunks", () => {
  const text = `${"a".repeat(2500)}\n\n${"b".repeat(2500)}`;
  expect(renderTelegram(text)[0].plain).toBe(`${"a".repeat(2500)}\n\n`);
  expect(renderTelegram("")).toEqual([]);
  expect(() => renderTelegram("a", 1)).toThrow("INVALID_CHUNK_LIMIT");
});
