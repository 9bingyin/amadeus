import type { Context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { CronExpressionParser } from "cron-parser";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const fields = {
  name: z.string().min(1),
  cwd: z.string().min(1),
  when: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("after"),
      delayMs: z.int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal("at"),
      at: z.iso.datetime({ offset: true }),
    }),
    z.strictObject({
      kind: z.literal("every"),
      intervalMs: z.int().positive(),
    }),
    z.strictObject({
      kind: z.literal("cron"),
      expression: z.string().regex(/\S/u),
      timezone: z.string().min(1),
    }),
  ]),
};
export const scriptScheduleSchema = z.strictObject({
  ...fields,
  command: z.string().min(1),
});
export const agentScheduleSchema = z.strictObject({
  ...fields,
  prompt: z.string().regex(/\S/u),
});
export const scheduleDefinitionSchema = z.union([
  scriptScheduleSchema,
  agentScheduleSchema,
]);
export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;

export function nextCron(
  cron: { expression: string; timezone: string },
  after: number,
) {
  return CronExpressionParser.parse(cron.expression, {
    currentDate: after,
    tz: cron.timezone,
    hashSeed: cron.expression,
  })
    .next()
    .getTime();
}

export function schedulePath(home: string, id: TaskId) {
  return join(home, "schedules", String(id), "plan.json");
}

export async function createScheduleFile(
  home: string,
  id: TaskId,
  definition: ScheduleDefinition,
  context: Context,
) {
  context.abortSignal?.throwIfAborted();
  const path = schedulePath(home, id);
  const root = dirname(path);
  for (const directory of [dirname(root), root]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    });
    z.literal(true).parse((await lstat(directory)).isDirectory());
  }
  const temporary = await mkdtemp(join(root, ".plan-"));
  try {
    const staged = join(temporary, "plan.json");
    await writeFile(staged, JSON.stringify(definition, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
      signal: context.abortSignal,
    });
    context.abortSignal?.throwIfAborted();
    await link(staged, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readScheduleFile(path: string) {
  const root = dirname(path);
  for (const directory of [dirname(root), root])
    z.literal(true).parse((await lstat(directory)).isDirectory());
  await using file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  z.literal(true).parse((await file.stat()).isFile());
  const definition = scheduleDefinitionSchema.parse(
    JSON.parse(await file.readFile("utf8")),
  );
  if (definition.when.kind === "cron") nextCron(definition.when, 0);
  return { ...definition, cwd: resolve(root, definition.cwd) };
}
