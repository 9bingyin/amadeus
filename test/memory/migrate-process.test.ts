import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/migrate-memory-daily.ts", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("amadeus-memory-migrate", () => {
  test("dry-run 不写入，apply 备份文件并推进 memory revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-memory-migrate-"));
    temporaryDirectories.push(root);
    const memoryDir = join(root, "memory");
    const stateDir = join(root, "state");
    const dailyPath = join(memoryDir, "daily", "2026-09-04.md");
    const statePath = join(stateDir, "memory", "state.json");
    await mkdir(dirname(dailyPath), { recursive: true });
    await mkdir(dirname(statePath), { recursive: true });
    const source = `<!-- 2026-09-04 11:03:25 [amadeus] -->
<!-- amadeus-memory:extract:123:session-a:64770:3027963:0:260576:0 -->
调查了 RTX Spark。
`;
    await writeFile(dailyPath, source);
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        memoryRevision: 4,
        qmdUpdatedRevision: 4,
        qmdEmbeddedRevision: 4,
      })}\n`,
    );

    const dryRun = await run(["--memory-dir", memoryDir]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      mode: "dry-run",
      changedFiles: 1,
      migratedFragments: 1,
      migratedSessions: 1,
      ambiguousFiles: 0,
      ambiguousFragments: 0,
    });
    expect(await readFile(dailyPath, "utf8")).toBe(source);

    const backupDir = join(root, "backup");
    const applied = await run([
      "--memory-dir",
      memoryDir,
      "--state-dir",
      stateDir,
      "--backup-dir",
      backupDir,
      "--apply",
      "--service-stopped",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "applied",
      changedFiles: 1,
      backupDir,
    });
    expect(await readFile(dailyPath, "utf8")).toContain(
      "## Session Summary (migrated)",
    );
    expect(
      await readFile(join(backupDir, "daily", "2026-09-04.md"), "utf8"),
    ).toBe(source);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      memoryRevision: 5,
      qmdUpdatedRevision: 4,
      qmdEmbeddedRevision: 4,
    });
    expect(await readdir(join(backupDir, "state", "memory"))).toEqual([
      "state.json",
    ]);
  });

  test("apply 遇到边界不明确的碎片时拒绝任何写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-memory-migrate-"));
    temporaryDirectories.push(root);
    const memoryDir = join(root, "memory");
    const stateDir = join(root, "state");
    const dailyPath = join(memoryDir, "daily", "2026-09-04.md");
    const statePath = join(stateDir, "memory", "state.json");
    await mkdir(dirname(dailyPath), { recursive: true });
    await mkdir(dirname(statePath), { recursive: true });
    const source = `<!-- 2026-09-04 11:03:25 [amadeus] -->\n<!-- amadeus-memory:extract:123:session-a:64770:3027963:0:260576:0 -->\n## 调查结果\n正文边界不明确。\n`;
    const state = `${JSON.stringify({
      version: 1,
      memoryRevision: 4,
      qmdUpdatedRevision: 4,
      qmdEmbeddedRevision: 4,
    })}\n`;
    await writeFile(dailyPath, source);
    await writeFile(statePath, state);

    const result = await run([
      "--memory-dir",
      memoryDir,
      "--state-dir",
      stateDir,
      "--apply",
      "--service-stopped",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("need manual review on: 2026-09-04");
    expect(await readFile(dailyPath, "utf8")).toBe(source);
    expect(await readFile(statePath, "utf8")).toBe(state);
  });
});

async function run(args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
