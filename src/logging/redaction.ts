const secretKeys = new Set([
  "token",
  "bottoken",
  "telegrambottoken",
  "authorization",
  "cookie",
  "cookies",
  "setcookie",
  "session",
  "sessionid",
  "sessiontoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "password",
  "secret",
  "storagestate",
  "localstorage",
  "browserprofile",
  "profiledata",
]);
const replacement = "[REDACTED]";

// Защита значений выполняется перед сериализацией и не изменяет данные владельца операции.
// Контракт принимает JSON metadata; browser objects и raw errors не являются log payload.
export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of knownSecrets) {
      if (!secret) continue;
      result = result.split(secret).join(replacement);
      result = result.split(encodeURIComponent(secret)).join(replacement);
    }
    return result
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, knownSecrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretKeys.has(key.replace(/[_-]/g, "").toLowerCase())
          ? replacement
          : redact(item, knownSecrets),
      ]),
    );
  }
  return value;
}
