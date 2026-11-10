import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export async function acquireLock(directory: string): Promise<FileHandle> {
  const file = await open(join(directory, "amadeus.lock"), "a+", 0o600);
  try {
    // stdin 与 file.fd 共享 open file description；命令退出后，本进程的 fd 继续持锁。
    const result = Bun.spawnSync(
      ["flock", "--exclusive", "--nonblock", "--verbose", "0"],
      {
        stdin: file.fd,
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    if (!result.success) throw result;
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
