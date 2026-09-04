import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  migrateLegacyExtractionFragments,
  migrateManagedAutoSummaries,
  type MemoryDailyMigrationResult,
} from "../src/memory/migrate";

interface Options {
  memoryDir: string;
  stateDir?: string;
  backupDir?: string;
  apply: boolean;
  serviceStopped: boolean;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
  gid: number;
}

interface MigrationPlan {
  name: string;
  path: string;
  identity: FileIdentity;
  result: MemoryDailyMigrationResult;
}

const options = parseArguments(Bun.argv.slice(2));
if (options.apply && !options.stateDir) {
  throw new Error("--state-dir is required with --apply");
}
if (options.apply && !options.serviceStopped) {
  throw new Error(
    "--service-stopped is required with --apply; stop Amadeus before migration",
  );
}
const memoryDir = await canonicalDirectory(options.memoryDir, "memory");
const dailyDir = await canonicalDirectory(join(memoryDir, "daily"), "daily");
const plans = await buildPlans(dailyDir);
const changedPlans = plans.filter(
  (plan) =>
    plan.result.migratedFragments > 0 ||
    plan.result.migratedManagedSummaries > 0,
);
const changedFiles = changedPlans.length;
const ambiguousDates = plans
  .filter((plan) => plan.result.ambiguousFragments > 0)
  .map((plan) => plan.name.slice(0, -3));
const ambiguousFiles = ambiguousDates.length;
const ambiguousFragments = plans.reduce(
  (total, plan) => total + plan.result.ambiguousFragments,
  0,
);
const migratedFragments = changedPlans.reduce(
  (total, plan) => total + plan.result.migratedFragments,
  0,
);
const migratedSessions = changedPlans.reduce(
  (total, plan) => total + plan.result.migratedSessions,
  0,
);
const migratedManagedSummaries = changedPlans.reduce(
  (total, plan) => total + plan.result.migratedManagedSummaries,
  0,
);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = resolve(
  options.backupDir ??
    join(dirname(memoryDir), `.amadeus-memory-backup-${timestamp}`),
);
const stateDir = options.apply
  ? await canonicalDirectory(options.stateDir ?? "", "state")
  : undefined;
if (stateDir) {
  await assertNoPreparedReceipts(stateDir);
}
if (options.apply && ambiguousFragments > 0) {
  throw new Error(
    `Refusing migration because ${ambiguousFragments} fragment(s) need manual review on: ${ambiguousDates.join(", ")}`,
  );
}
if (stateDir && changedPlans.length > 0) {
  await bumpMemoryRevision(stateDir, backupDir);
  for (const plan of changedPlans) {
    await assertUnchanged(plan.path, plan.identity, plan.name);
    await backupFile(
      plan.path,
      join(backupDir, "daily", plan.name),
      plan.identity,
    );
    await atomicReplace(plan.path, plan.result.content, plan.identity);
  }
}

console.log(
  JSON.stringify({
    mode: options.apply ? "applied" : "dry-run",
    changedFiles,
    migratedFragments,
    migratedSessions,
    migratedManagedSummaries,
    ambiguousFiles,
    ambiguousFragments,
    ambiguousDates,
    ...(options.apply && changedFiles > 0 ? { backupDir } : {}),
  }),
);

async function buildPlans(dailyDir: string): Promise<MigrationPlan[]> {
  const names: string[] = [];
  const directory = await opendir(dailyDir);
  for await (const entry of directory) {
    if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) {
      names.push(entry.name);
    }
  }

  const plans: MigrationPlan[] = [];
  for (const name of names.sort()) {
    const path = join(dailyDir, name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`daily entry is not a regular file: ${name}`);
    }
    plans.push({
      name,
      path,
      identity: fileIdentity(stats),
      result: migrateDailyFile(await readFile(path, "utf8")),
    });
  }
  return plans;
}

function migrateDailyFile(content: string): MemoryDailyMigrationResult {
  const legacy = migrateLegacyExtractionFragments(content);
  if (legacy.ambiguousFragments > 0) {
    return legacy;
  }
  const managed = migrateManagedAutoSummaries(legacy.content);
  return {
    content: managed.content,
    migratedFragments: legacy.migratedFragments,
    migratedSessions: legacy.migratedSessions,
    migratedManagedSummaries: managed.migratedManagedSummaries,
    ambiguousFragments: managed.ambiguousFragments,
  };
}

async function assertNoPreparedReceipts(stateDir: string): Promise<void> {
  const configuredReceiptsDir = join(stateDir, "memory", "receipts");
  try {
    await lstat(configuredReceiptsDir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const receiptsDir = await canonicalDirectory(
    configuredReceiptsDir,
    "memory receipts",
  );
  const directory = await opendir(receiptsDir);
  for await (const entry of directory) {
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(receiptsDir, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("memory receipt must be a regular file");
    }
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "prepared"
    ) {
      throw new Error(
        "prepared memory receipt must be recovered before migration",
      );
    }
  }
}

async function bumpMemoryRevision(
  stateDir: string,
  backupDir: string,
): Promise<void> {
  const path = join(stateDir, "memory", "state.json");
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("memory state must be a regular file");
  }
  const identity = fileIdentity(stats);
  const source = await readFile(path, "utf8");
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("memoryRevision" in value) ||
    typeof value.memoryRevision !== "number" ||
    !Number.isSafeInteger(value.memoryRevision) ||
    value.memoryRevision < 0 ||
    value.memoryRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("memory state has an invalid schema");
  }
  await assertUnchanged(path, identity, "memory/state.json");
  await backupFile(
    path,
    join(backupDir, "state", "memory", "state.json"),
    identity,
  );
  await atomicReplace(
    path,
    `${JSON.stringify(
      { ...value, memoryRevision: value.memoryRevision + 1 },
      null,
      2,
    )}\n`,
    identity,
  );
}

function parseArguments(args: readonly string[]): Options {
  let memoryDir: string | undefined;
  let stateDir: string | undefined;
  let backupDir: string | undefined;
  let apply = false;
  let serviceStopped = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--service-stopped") {
      serviceStopped = true;
      continue;
    }
    if (
      argument === "--memory-dir" ||
      argument === "--state-dir" ||
      argument === "--backup-dir"
    ) {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === "--memory-dir") {
        memoryDir = value;
      } else if (argument === "--state-dir") {
        stateDir = value;
      } else {
        backupDir = value;
      }
      index += 1;
      continue;
    }
    if (argument === "--help") {
      console.log(
        "Usage: amadeus-memory-migrate --memory-dir PATH [--apply --service-stopped --state-dir PATH] [--backup-dir PATH]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }
  if (!memoryDir) {
    throw new Error("--memory-dir is required");
  }
  return {
    memoryDir: resolve(memoryDir),
    ...(stateDir ? { stateDir: resolve(stateDir) } : {}),
    ...(backupDir ? { backupDir: resolve(backupDir) } : {}),
    apply,
    serviceStopped,
  };
}

async function canonicalDirectory(path: string, name: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${name} path must be a real directory`);
  }
  return realpath(path);
}

function fileIdentity(stats: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
  gid: number;
}): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
  };
}

async function assertUnchanged(
  path: string,
  expected: FileIdentity,
  name: string,
): Promise<void> {
  const actual = await lstat(path);
  if (
    actual.isSymbolicLink() ||
    !actual.isFile() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`file changed during migration: ${name}`);
  }
}

async function backupFile(
  source: string,
  destination: string,
  identity: FileIdentity,
): Promise<void> {
  await ensureDirectorySynced(dirname(destination));
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, identity.mode);
  await chown(destination, identity.uid, identity.gid);
  const backup = await open(destination, "r");
  try {
    await backup.sync();
  } finally {
    await backup.close();
  }
  await syncDirectory(dirname(destination));
}

async function ensureDirectorySynced(path: string): Promise<void> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`backup path is not a real directory: ${current}`);
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) {
        throw new Error("Cannot find an existing backup directory ancestor");
      }
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory);
    await syncDirectory(dirname(directory));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

async function atomicReplace(
  path: string,
  content: string,
  identity: FileIdentity,
): Promise<void> {
  const temporaryPath = `${path}.migrate-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", identity.mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.chmod(identity.mode);
    await handle.chown(identity.uid, identity.gid);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
