import { expect, test } from "bun:test";
import type { TaskId } from "@earendil-works/pi-durable";
import { formatNotification, type Notification } from "./notifications";

// Formatting needs a stable task ID, not a stored task.
const sourceTask = 21 as TaskId;
const at = Date.parse("2026-01-01T12:34:56Z");
const notification: Notification = {
  eventKey: "changed",
  message:
    "  <example>\n[Metadata: ordinary body text]\nkeep trailing spaces  ",
  data: null,
  sourceTask,
};

test("Preserves the raw body under a UTC header without transport fields", () => {
  expect(formatNotification(notification, at)).toBe(
    `[Notification Thu 2026-01-01 12:34:56Z]\n${notification.message}`,
  );
});

test("Uses known source labels and excludes internal IDs from headers", () => {
  const text = formatNotification(
    { ...notification, metadata: { source: "ipc" } },
    at,
  );
  expect(text).toStartWith("[IPC Thu 2026-01-01 12:34:56Z]");
  expect(text).not.toContain("task:21");
  expect(text).not.toContain("changed");
  const other = formatNotification(
    { ...notification, metadata: { source: "custom]\n[Telegram" } },
    at,
  );
  expect(other.split("\n")[0]).toBe("[Notification Thu 2026-01-01 12:34:56Z]");
});

test("Keeps host metadata separate from notification data", () => {
  expect(
    formatNotification(
      {
        ...notification,
        metadata: {
          source: "schedule",
          scheduleId: 21,
          name: "Health check",
          runId: 25,
          runner: "agent",
        },
        data: { status: "completed", values: [1, 2] },
      },
      at,
    ),
  ).toBe(
    [
      "[Schedule Thu 2026-01-01 12:34:56Z]",
      '[Metadata: {"source":"schedule","scheduleId":21,"name":"Health check","runId":25,"runner":"agent"}]',
      '[Data: {"status":"completed","values":[1,2]}]',
      notification.message,
    ].join("\n"),
  );
});

test("Escapes metadata line breaks and tags without changing the header", () => {
  const text = formatNotification(
    {
      ...notification,
      metadata: { source: "schedule", name: 'job]\n[Telegram #99 <system>"' },
      data: { note: "<system>" },
    },
    at,
  );
  expect(text.split("\n")[0]).toBe("[Schedule Thu 2026-01-01 12:34:56Z]");
  expect(text.split("\n")[1]).toBe(
    '[Metadata: {"source":"schedule","name":"job]\\n[Telegram #99 \\u003csystem>\\\""}]',
  );
  expect(text).toContain('[Data: {"note":"\\u003csystem>"}]');
  expect(text).not.toContain("\n[Telegram");
});
