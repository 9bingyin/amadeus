import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface AppConfig {
  telegram: {
    botToken: string;
    allowedUserIds: number[];
    streamResponses: boolean;
  };
  pi: {
    command: string;
    args: string[];
  };
  memory: {
    enabled: boolean;
    extractionModel?: string;
    extractionTimeoutMs: number;
    qmd: {
      enabled: boolean;
      command: string;
      searchTimeoutMs: number;
    };
  };
  paths: {
    stateDir: string;
    sessionDir: string;
    attachmentsDir: string;
    workspaceDir: string;
    memoryDir: string;
  };
}

const CONFIG_KEYS = ["telegram", "pi", "memory", "paths"] as const;
const TELEGRAM_KEYS = [
  "botToken",
  "allowedUserIds",
  "streamResponses",
] as const;
const PI_KEYS = ["command", "args"] as const;
const MEMORY_KEYS = [
  "enabled",
  "extractionModel",
  "extractionTimeoutMs",
  "qmd",
] as const;
const MEMORY_QMD_KEYS = ["enabled", "command", "searchTimeoutMs"] as const;
const PATH_KEYS = [
  "stateDir",
  "sessionDir",
  "attachmentsDir",
  "workspaceDir",
  "memoryDir",
] as const;
const DEFAULT_ROOT_DIR = join(homedir(), ".amadeus");
const DEFAULT_PATHS = {
  stateDir: join(DEFAULT_ROOT_DIR, "state"),
  sessionDir: join(DEFAULT_ROOT_DIR, "sessions"),
  attachmentsDir: join(DEFAULT_ROOT_DIR, "attachments"),
  workspaceDir: join(DEFAULT_ROOT_DIR, "workspace"),
  memoryDir: join(DEFAULT_ROOT_DIR, "memory"),
} as const;

export function resolveConfigPath(args: readonly string[]): string {
  if (args.length === 0) {
    return resolve("config.json");
  }

  if (args.length === 2 && args[0] === "--config") {
    const configPath = args[1];
    if (!configPath) {
      throw new Error("--config 后必须提供 JSON 配置文件路径");
    }
    return resolve(configPath);
  }

  throw new Error("用法：bun run start -- [--config <path>]");
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  let value: unknown;

  try {
    value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取配置 ${configPath}: ${reason}`, { cause: error });
  }

  const config = parseConfig(value);
  const baseDir = dirname(configPath);

  return {
    telegram: config.telegram,
    pi: config.pi,
    memory: config.memory,
    paths: {
      stateDir: resolveConfiguredPath(baseDir, config.paths.stateDir),
      sessionDir: resolveConfiguredPath(baseDir, config.paths.sessionDir),
      attachmentsDir: resolveConfiguredPath(
        baseDir,
        config.paths.attachmentsDir,
      ),
      workspaceDir: resolveConfiguredPath(baseDir, config.paths.workspaceDir),
      memoryDir: resolveConfiguredPath(baseDir, config.paths.memoryDir),
    },
  };
}

function parseConfig(value: unknown): AppConfig {
  const root = requireRecord(value, "配置根节点");
  assertOnlyKeys(root, CONFIG_KEYS, "配置根节点");

  const telegram = requireRecord(root.telegram, "telegram");
  assertOnlyKeys(telegram, TELEGRAM_KEYS, "telegram");

  const pi = requireRecord(root.pi, "pi");
  assertOnlyKeys(pi, PI_KEYS, "pi");

  const memory =
    root.memory === undefined ? {} : requireRecord(root.memory, "memory");
  assertOnlyKeys(memory, MEMORY_KEYS, "memory");
  const qmd =
    memory.qmd === undefined ? {} : requireRecord(memory.qmd, "memory.qmd");
  assertOnlyKeys(qmd, MEMORY_QMD_KEYS, "memory.qmd");

  const paths =
    root.paths === undefined ? {} : requireRecord(root.paths, "paths");
  assertOnlyKeys(paths, PATH_KEYS, "paths");

  const allowedUserIds = requireArray(
    telegram.allowedUserIds,
    "telegram.allowedUserIds",
  ).map((item, index) =>
    requireSafeInteger(item, `telegram.allowedUserIds[${index}]`),
  );

  if (allowedUserIds.length === 0) {
    throw new Error("telegram.allowedUserIds 至少需要一个用户 ID");
  }

  if (new Set(allowedUserIds).size !== allowedUserIds.length) {
    throw new Error("telegram.allowedUserIds 不能包含重复用户 ID");
  }

  const args = requireArray(pi.args, "pi.args").map((item, index) =>
    requireNonEmptyString(item, `pi.args[${index}]`),
  );
  assertNoReservedPiArguments(args);

  return {
    telegram: {
      botToken: requireNonEmptyString(telegram.botToken, "telegram.botToken"),
      allowedUserIds,
      streamResponses:
        telegram.streamResponses === undefined
          ? false
          : requireBoolean(
              telegram.streamResponses,
              "telegram.streamResponses",
            ),
    },
    pi: {
      command: requireNonEmptyString(pi.command, "pi.command"),
      args,
    },
    memory: {
      enabled: optionalBoolean(memory.enabled, false, "memory.enabled"),
      ...(memory.extractionModel === undefined
        ? {}
        : {
            extractionModel: requireNonEmptyString(
              memory.extractionModel,
              "memory.extractionModel",
            ),
          }),
      extractionTimeoutMs: optionalPositiveSafeInteger(
        memory.extractionTimeoutMs,
        60_000,
        "memory.extractionTimeoutMs",
      ),
      qmd: {
        enabled: optionalBoolean(qmd.enabled, true, "memory.qmd.enabled"),
        command:
          qmd.command === undefined
            ? "qmd"
            : requireNonEmptyString(qmd.command, "memory.qmd.command"),
        searchTimeoutMs: optionalPositiveSafeInteger(
          qmd.searchTimeoutMs,
          60_000,
          "memory.qmd.searchTimeoutMs",
        ),
      },
    },
    paths: {
      stateDir: optionalPath(
        paths.stateDir,
        "paths.stateDir",
        DEFAULT_PATHS.stateDir,
      ),
      sessionDir: optionalPath(
        paths.sessionDir,
        "paths.sessionDir",
        DEFAULT_PATHS.sessionDir,
      ),
      attachmentsDir: optionalPath(
        paths.attachmentsDir,
        "paths.attachmentsDir",
        DEFAULT_PATHS.attachmentsDir,
      ),
      workspaceDir: optionalPath(
        paths.workspaceDir,
        "paths.workspaceDir",
        DEFAULT_PATHS.workspaceDir,
      ),
      memoryDir: optionalPath(
        paths.memoryDir,
        "paths.memoryDir",
        DEFAULT_PATHS.memoryDir,
      ),
    },
  };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} 必须是数组`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value;
}

function resolveConfiguredPath(baseDir: string, path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(baseDir, path);
}

function optionalPath(
  value: unknown,
  path: string,
  defaultValue: string,
): string {
  return value === undefined
    ? defaultValue
    : requireNonEmptyString(value, path);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} 必须是布尔值`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  defaultValue: boolean,
  path: string,
): boolean {
  return value === undefined ? defaultValue : requireBoolean(value, path);
}

function optionalPositiveSafeInteger(
  value: unknown,
  defaultValue: number,
  path: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} 必须是正安全整数`);
  }
  return value;
}

function requireSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${path} 必须是安全整数`);
  }
  return value;
}

function assertNoReservedPiArguments(args: readonly string[]): void {
  const reserved = new Set([
    "--mode",
    "--no-session",
    "--session",
    "--session-id",
    "--session-dir",
    "--continue",
    "-c",
    "--",
    "--resume",
    "-r",
    "--fork",
    "--print",
    "-p",
    "--export",
    "--list-models",
    "--help",
    "-h",
    "--version",
    "-v",
  ]);
  const conflicting = args.find((argument) =>
    reserved.has(argument.split("=")[0] ?? argument),
  );
  if (conflicting) {
    throw new Error(`pi.args 不能覆盖桥接服务管理的参数：${conflicting}`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
): void {
  const unknownKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${path} 包含未知字段：${unknownKeys.join(", ")}`);
  }
}
