import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiSessionFileMissingError,
  resolvePiSessionLaunch,
} from "../../src/pi-rpc/client-factory";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("resolvePiSessionLaunch", () => {
  test("session 与 workspace 相同时直接恢复", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const sessionFile = join(root, "session.jsonl");
    await mkdir(workspace);
    await writeSession(sessionFile, workspace);

    await expect(
      resolvePiSessionLaunch(sessionFile, workspace),
    ).resolves.toEqual({
      file: sessionFile,
      mode: "resume",
    });
  });

  test("session 与 workspace 不同时通过 fork 迁移", async () => {
    const root = await temporaryDirectory();
    const oldWorkspace = join(root, "old-workspace");
    const newWorkspace = join(root, "new-workspace");
    const sessionFile = join(root, "session.jsonl");
    await Promise.all([mkdir(oldWorkspace), mkdir(newWorkspace)]);
    await writeSession(sessionFile, oldWorkspace);

    await expect(
      resolvePiSessionLaunch(sessionFile, newWorkspace, "initialize"),
    ).resolves.toEqual({
      file: sessionFile,
      mode: "fork",
    });
  });

  test("只允许重新初始化明确标记为空且尚未落盘的 session", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const sessionFile = join(root, "missing-session.jsonl");
    await mkdir(workspace);

    await expect(
      resolvePiSessionLaunch(sessionFile, workspace),
    ).rejects.toBeInstanceOf(PiSessionFileMissingError);
    await expect(
      resolvePiSessionLaunch(sessionFile, workspace, "initialize"),
    ).resolves.toEqual({
      mode: "initialize",
    });
  });

  test("允许初始化时仍拒绝损坏的现有 session", async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    const sessionFile = join(root, "broken-session.jsonl");
    await mkdir(workspace);
    await writeFile(sessionFile, "not-json\n");

    await expect(
      resolvePiSessionLaunch(sessionFile, workspace, "initialize"),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amadeus-session-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSession(path: string, cwd: string): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    })}\n`,
  );
}
