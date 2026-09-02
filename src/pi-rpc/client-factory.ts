import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { InfoLogger } from "../logging/logger";
import { PiRpcClient, type PiRpcClientLike } from "./client";
import {
  spawnPiRpcTransport,
  type PiProcessOptions,
  type PiSessionLaunch,
} from "./transport";

export interface PiRpcClientFactory {
  create(chatId: number, sessionFile?: string): Promise<PiRpcClientLike>;
}

export type PiRpcClientFactoryOptions = Omit<PiProcessOptions, "session"> & {
  logger?: InfoLogger;
};

export function createPiRpcClientFactory(
  options: PiRpcClientFactoryOptions,
): PiRpcClientFactory {
  const { logger, ...processOptions } = options;
  return {
    async create(_chatId, sessionFile) {
      const session = sessionFile
        ? await resolvePiSessionLaunch(sessionFile, processOptions.cwd)
        : undefined;
      return new PiRpcClient(
        spawnPiRpcTransport({
          ...processOptions,
          ...(session ? { session } : {}),
        }),
        logger,
        session?.mode,
      );
    },
  };
}

const MAX_SESSION_HEADER_BYTES = 16 * 1024;

export async function resolvePiSessionLaunch(
  sessionFile: string,
  workspaceDir: string,
): Promise<PiSessionLaunch> {
  const sessionCwd = await readSessionCwd(sessionFile);
  const [resolvedSessionCwd, resolvedWorkspaceDir] = await Promise.all([
    canonicalPath(sessionCwd),
    canonicalPath(workspaceDir),
  ]);
  return {
    file: sessionFile,
    mode: resolvedSessionCwd === resolvedWorkspaceDir ? "resume" : "fork",
  };
}

async function readSessionCwd(sessionFile: string): Promise<string> {
  const handle = await open(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.toString("utf8", 0, bytesRead);
    const newline = content.indexOf("\n");
    if (newline < 0) {
      throw new Error("Pi session 文件缺少完整 header");
    }
    const line = content.slice(0, newline).replace(/\r$/, "");
    const header = JSON.parse(line) as unknown;
    if (
      typeof header !== "object" ||
      header === null ||
      Array.isArray(header) ||
      !("type" in header) ||
      header.type !== "session" ||
      !("cwd" in header) ||
      typeof header.cwd !== "string" ||
      header.cwd.length === 0
    ) {
      throw new Error("Pi session header 缺少有效 cwd");
    }
    return header.cwd;
  } finally {
    await handle.close();
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
