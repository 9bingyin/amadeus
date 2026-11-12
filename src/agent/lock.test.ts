import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "./lock";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "amadeus-lock-"));
  directories.push(path);
  return path;
}

async function ready(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  try {
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("ready\n");
  } finally {
    reader.releaseLock();
  }
}

test("Enforces one writer and reuses the lock file after release", async () => {
  const home = await directory();
  const path = join(home, "amadeus.lock");
  let inode: number;
  {
    await using first = await acquireLock(home);
    const info = await stat(path);
    inode = info.ino;
    expect(info.mode & 0o777).toBe(0o600);
    await expect(acquireLock(home)).rejects.toMatchObject({
      exitCode: 1,
      success: false,
    });
    await using separate = await acquireLock(await directory());
    expect(separate.fd).not.toBe(first.fd);
  }
  await using next = await acquireLock(home);
  expect((await next.stat()).ino).toBe(inode);
});

test("Releases the kernel lock when the owner is killed", async () => {
  const home = await directory();
  const script = `
    import { acquireLock } from ${JSON.stringify(import.meta.resolve("./lock.ts"))};
    const lock = await acquireLock(process.argv[1]);
    console.log("ready");
    await Bun.stdin.text();
    await lock.close();
  `;
  const child = Bun.spawn([process.execPath, "--eval", script, home], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    await ready(child.stdout);
    await expect(acquireLock(home)).rejects.toMatchObject({
      exitCode: 1,
      success: false,
    });
    child.kill("SIGKILL");
    await child.exited;
    await using next = await acquireLock(home);
    expect(next.fd).toBeGreaterThanOrEqual(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("Does not pass the directory lock to child processes", async () => {
  const home = await directory();
  await using lock = await acquireLock(home);
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'console.log("ready"); await Bun.stdin.text();',
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  try {
    await ready(child.stdout);
    await lock.close();
    await using next = await acquireLock(home);
    expect(child.exitCode).toBeNull();
    expect(next.fd).toBeGreaterThanOrEqual(0);
  } finally {
    child.stdin.end();
    await child.exited;
  }
});
