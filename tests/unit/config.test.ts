import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ConfigError, loadConfig, loadDatabaseConfig } from "../../src/config/Config";

const environment = {
  TELEGRAM_BOT_TOKEN: "r0-fixture-token",
  TELEGRAM_ALLOWED_USER_IDS: "123, 456,123",
};

describe("configuration", () => {
  test("uses defaults and keeps deduplicated Telegram IDs as strings", () => {
    const config = loadConfig(environment, "/tmp/r0-config");
    expect(config.telegram.allowedUserIds).toEqual(["123", "456"]);
    expect(config.database.path).toBe("/tmp/r0-config/data/gateway.sqlite");
    expect(config.browser.profileDir).toBe("/tmp/r0-config/data/browser-profile");
    expect(config.attachments.tempDir).toBe("/tmp/r0-config/data/tmp");
    expect(config.provider.type).toBe("chatgpt-web");
    expect(config.requests.generationTimeoutMs).toBe(600000);
    expect(config.queue.maxPendingPerConversation).toBe(20);
    expect(config.attachments.maxFilesPerRequest).toBe(10);
    expect(config.attachments.maxFileSizeBytes).toBe(52428800);
    expect(config.logging).toEqual({ level: "info", content: false });
  });

  test("blank optional values select defaults", () => {
    const config = loadConfig({ ...environment, DATABASE_PATH: "  ", LOG_CONTENT: "" });
    expect(config.database.path).toBe(resolve("data/gateway.sqlite"));
    expect(config.logging.content).toBe(false);
  });

  test.each([undefined, "", "  "])("rejects a missing or blank token: %s", (token) => {
    expect(() => loadConfig({ ...environment, TELEGRAM_BOT_TOKEN: token })).toThrow(ConfigError);
  });

  test.each([undefined, "", " ", "0", "-123", "123,", "123,nope"])(
    "rejects a missing or invalid allowlist: %s",
    (ids) => {
      expect(() => loadConfig({ ...environment, TELEGRAM_ALLOWED_USER_IDS: ids })).toThrow(
        ConfigError,
      );
    },
  );

  test("retains IDs beyond JavaScript number precision", () => {
    expect(
      loadConfig({ ...environment, TELEGRAM_ALLOWED_USER_IDS: "9007199254740993" }).telegram
        .allowedUserIds,
    ).toEqual(["9007199254740993"]);
  });

  test.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "rejects invalid positive integers: %s",
    (value) => {
      for (const field of [
        "GENERATION_TIMEOUT_MS",
        "MAX_PENDING_PER_CONVERSATION",
        "ATTACHMENT_MAX_FILES_PER_REQUEST",
        "ATTACHMENT_MAX_FILE_SIZE_BYTES",
      ]) {
        expect(() => loadConfig({ ...environment, [field]: value })).toThrow(ConfigError);
      }
    },
  );

  test("parses false as false and true as true", () => {
    expect(loadConfig({ ...environment, LOG_CONTENT: "false" }).logging.content).toBe(false);
    expect(loadConfig({ ...environment, LOG_CONTENT: "true" }).logging.content).toBe(true);
    expect(() => loadConfig({ ...environment, LOG_CONTENT: "yes" })).toThrow(ConfigError);
  });

  test("generation deadline rejects timer overflow instead of becoming a 1ms timeout", () => {
    expect(
      loadConfig({ ...environment, GENERATION_TIMEOUT_MS: "2147483647" }).requests
        .generationTimeoutMs,
    ).toBe(2147483647);
    expect(() => loadConfig({ ...environment, GENERATION_TIMEOUT_MS: "2147483648" })).toThrow(
      ConfigError,
    );
  });

  test("rejects unsupported provider and log level", () => {
    expect(() => loadConfig({ ...environment, PROVIDER_TYPE: "api" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...environment, LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  test("errors describe fields without exposing invalid values", () => {
    try {
      loadConfig({ ...environment, LOG_LEVEL: environment.TELEGRAM_BOT_TOKEN });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.code).toBe("CONFIG_ERROR");
      expect(configError.issues).toEqual([{ field: "LOG_LEVEL", reason: "invalid_log_level" }]);
      expect(JSON.stringify(configError)).not.toContain(environment.TELEGRAM_BOT_TOKEN);
    }
  });

  test("database maintenance needs no transport credentials", () => {
    expect(loadDatabaseConfig({}, "/tmp/r0-maintenance")).toEqual({
      path: "/tmp/r0-maintenance/data/gateway.sqlite",
    });
    expect(loadDatabaseConfig({ DATABASE_PATH: "/tmp/r0.sqlite" }).path).toBe("/tmp/r0.sqlite");
  });
});
