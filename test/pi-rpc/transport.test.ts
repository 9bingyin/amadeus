import { describe, expect, test } from "bun:test";
import { buildPiRpcArgs } from "../../src/pi-rpc/transport";

describe("buildPiRpcArgs", () => {
  test("保留 Pi 扩展和模型参数并恢复同工作区 session", () => {
    expect(
      buildPiRpcArgs({
        command: "pi",
        cwd: "/project",
        args: [
          "--extension",
          "/user/extension.ts",
          "--provider",
          "openai-codex",
          "--model",
          "gpt-5.6-sol",
        ],
        sessionDir: "/sessions",
        session: { mode: "resume", file: "/sessions/chat.jsonl" },
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/sessions",
      "--session",
      "/sessions/chat.jsonl",
      "--extension",
      "/user/extension.ts",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-sol",
    ]);
  });

  test("工作区变化时通过 fork 迁移 session", () => {
    expect(
      buildPiRpcArgs({
        command: "pi",
        cwd: "/new-project",
        args: [],
        sessionDir: "/sessions",
        session: { mode: "fork", file: "/sessions/chat.jsonl" },
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--session-dir",
      "/sessions",
      "--fork",
      "/sessions/chat.jsonl",
    ]);
  });

  test("未落盘的空 session 重新初始化时不传旧路径", () => {
    expect(
      buildPiRpcArgs({
        command: "pi",
        cwd: "/project",
        args: [],
        sessionDir: "/sessions",
        session: { mode: "initialize" },
      }),
    ).toEqual(["--mode", "rpc", "--session-dir", "/sessions"]);
  });
});
