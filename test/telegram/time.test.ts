import { describe, expect, test } from "bun:test";
import { telegramTimestamp } from "../../src/telegram/time";

describe("telegramTimestamp", () => {
  test("将 Telegram Unix 时间格式化为 UTC", () => {
    expect(telegramTimestamp(1788279056)).toBe("2026-09-01T16:10:56Z");
  });
});
