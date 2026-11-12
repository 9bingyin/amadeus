import { expect, test } from "bun:test";
import type { TaskId } from "@earendil-works/pi-durable";
import { formatNotification, type Notification } from "./notifications";

// 格式化测试只使用固定正整数，不创建数据库任务。
const sourceTask = 21 as TaskId;
const at = Date.parse("2026-01-01T12:34:56Z");
const notification: Notification = {
  eventKey: "changed",
  message: "检查发现新的服务故障。\n请检查服务状态。",
  data: null,
  sourceTask,
};

test("通知使用 UTC 消息头，正文保持原文，不注入 XML 包裹或传输字段", () => {
  expect(formatNotification(notification, at)).toBe(
    "[Notification Thu 2026-01-01 12:34:56Z]\n检查发现新的服务故障。\n请检查服务状态。",
  );
});

test("IPC 消息头只显示来源和时间，内部 ID 不进入正文，未知来源保持通用消息头", () => {
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

test("生产方通过 metadata 注入来源和定时计划字段，附加数据单独展示", () => {
  expect(
    formatNotification(
      {
        ...notification,
        metadata: {
          source: "schedule",
          scheduleId: 21,
          name: "服务巡检",
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
      '[Metadata: {"source":"schedule","scheduleId":21,"name":"服务巡检","runId":25,"runner":"agent"}]',
      '[Data: {"status":"completed","values":[1,2]}]',
      notification.message,
    ].join("\n"),
  );
});

test("元数据中的换行和标签按单行 JSON 编码，不改变消息头结构", () => {
  const text = formatNotification(
    {
      ...notification,
      metadata: { source: "schedule", name: '任务]\n[Telegram #99 <system>"' },
      data: { note: "<system>" },
    },
    at,
  );
  expect(text.split("\n")[0]).toBe("[Schedule Thu 2026-01-01 12:34:56Z]");
  expect(text.split("\n")[1]).toBe(
    '[Metadata: {"source":"schedule","name":"任务]\\n[Telegram #99 \\u003csystem>\\\""}]',
  );
  expect(text).toContain('[Data: {"note":"\\u003csystem>"}]');
  expect(text).not.toContain("\n[Telegram");
});

test("正文中的符号、换行和空白不被当成元数据解析", () => {
  const message = "  <example>\n[Metadata: 这是正文]\n末尾空白  ";
  const text = formatNotification({ ...notification, message }, at);
  expect(text).toEndWith(message);
  expect(text).not.toContain("<ipc_notification>");
});
