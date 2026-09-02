import { StrictJsonlDecoder } from "./jsonl";

export interface PiRpcTransport {
  sendLine(line: string): Promise<void>;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface PiSessionLaunch {
  file: string;
  mode: "resume" | "fork";
}

export interface PiProcessOptions {
  command: string;
  cwd: string;
  args: readonly string[];
  sessionDir: string;
  session?: PiSessionLaunch;
}

export function buildPiRpcArgs(options: PiProcessOptions): string[] {
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    options.sessionDir,
    ...(options.session
      ? [
          options.session.mode === "fork" ? "--fork" : "--session",
          options.session.file,
        ]
      : []),
    ...options.args,
  ];
  return args;
}

const PROCESS_EXIT_TIMEOUT_MS = 2_000;

export function spawnPiRpcTransport(options: PiProcessOptions): PiRpcTransport {
  const args = buildPiRpcArgs(options);

  const subprocess = Bun.spawn([options.command, ...args], {
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  let closed = false;
  let writeQueue = Promise.resolve();

  return {
    async sendLine(line: string): Promise<void> {
      if (closed) {
        throw new Error("Pi RPC 子进程已经关闭");
      }
      if (line.includes("\n") || line.includes("\r")) {
        throw new Error("单条 Pi RPC 命令不能包含换行符");
      }

      const operation = writeQueue.then(async () => {
        subprocess.stdin.write(`${line}\n`);
        await subprocess.stdin.flush();
      });
      writeQueue = operation.catch(() => undefined);
      await operation;
    },

    async *lines(): AsyncIterable<string> {
      const decoder = new StrictJsonlDecoder();
      const reader = subprocess.stdout.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          for (const line of decoder.push(result.value)) {
            yield line;
          }
        }
        for (const line of decoder.finish()) {
          yield line;
        }
      } finally {
        reader.releaseLock();
      }

      const exitCode = await subprocess.exited;
      if (!closed && exitCode !== 0) {
        throw new Error(`Pi RPC 子进程异常退出，状态码 ${exitCode}`);
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      subprocess.stdin.end();
      subprocess.kill();
      if (!(await settlesWithin(subprocess.exited, PROCESS_EXIT_TIMEOUT_MS))) {
        subprocess.kill(9);
        if (
          !(await settlesWithin(subprocess.exited, PROCESS_EXIT_TIMEOUT_MS))
        ) {
          throw new Error("Pi RPC 子进程无法终止");
        }
      }
    },
  };
}

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
