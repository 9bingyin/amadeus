import type { Context } from "@earendil-works/chord/context";
import type { CompactionPolicy } from "@earendil-works/pi-durable";
import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { agentConfigSchema } from "../../config/providers";

export const planIdSchema = z.uuid().brand<"PlanId">();
export type PlanId = z.infer<typeof planIdSchema>;
export const planStatusSchema = z.enum(["enabled", "disabled", "deleted"]);
export const planMetaSchema = z.strictObject({
  owner: z.int().positive(),
  status: planStatusSchema,
  createdAt: z.int().nonnegative(),
  activatedAt: z.int().nonnegative(),
  activation: z.int().positive(),
  registered: z.boolean(),
});
export type PlanMeta = z.infer<typeof planMetaSchema>;

const compactionFields = {
  enabled: z.boolean().optional(),
  reserveTokens: z.int().nonnegative().optional(),
  keepRecentTokens: z.int().nonnegative().optional(),
  backgroundTokens: z.int().nonnegative().optional(),
};
const compactionPolicySchema = z.strictObject(compactionFields);
function compactionPolicy(
  value: z.infer<typeof compactionPolicySchema>,
): Partial<CompactionPolicy> {
  // Zod optional 的类型含 undefined；原生 exact 可选字段需要省略缺省值。
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(value.reserveTokens === undefined
      ? {}
      : { reserveTokens: value.reserveTokens }),
    ...(value.keepRecentTokens === undefined
      ? {}
      : { keepRecentTokens: value.keepRecentTokens }),
    ...(value.backgroundTokens === undefined
      ? {}
      : { backgroundTokens: value.backgroundTokens }),
  };
}
const compactionSchema = z
  .strictObject({
    ...compactionFields,
    modelOverrides: z
      .record(z.string(), compactionPolicySchema.transform(compactionPolicy))
      .optional(),
  })
  .transform((value) => ({
    ...compactionPolicy(value),
    ...(value.modelOverrides === undefined
      ? {}
      : { modelOverrides: value.modelOverrides }),
  }));
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
  agent: agentConfigSchema.extend({
    extensions: z.array(z.string().min(1)),
    tools: z.array(z.string().min(1)),
    compaction: compactionSchema.optional(),
  }),
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
export function firstAt(definition: ScheduleDefinition, activatedAt: number) {
  const when = definition.when;
  return z
    .int()
    .nonnegative()
    .parse(
      when.kind === "cron"
        ? nextCron(when, activatedAt)
        : when.kind === "at"
          ? Date.parse(when.at)
          : activatedAt +
            (when.kind === "every" ? when.intervalMs : when.delayMs),
    );
}
export function newPlanId() {
  return planIdSchema.parse(randomUUID());
}
export function planDirectory(home: string, id: PlanId) {
  return join(home, "schedules", id);
}
export function schedulePath(home: string, id: PlanId) {
  return join(planDirectory(home, id), "plan.json");
}
export function metaPath(home: string, id: PlanId) {
  return join(planDirectory(home, id), "meta.json");
}

export async function ensureDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  z.literal(true).parse((await lstat(path)).isDirectory());
}
async function readJson(path: string): Promise<unknown> {
  const root = dirname(path);
  for (const directory of [dirname(root), root])
    z.literal(true).parse((await lstat(directory)).isDirectory());
  await using file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  z.literal(true).parse((await file.stat()).isFile());
  return JSON.parse(await file.readFile("utf8"));
}
export async function createPlan(
  home: string,
  id: PlanId,
  meta: PlanMeta,
  definition: ScheduleDefinition,
  context: Context,
) {
  context.abortSignal?.throwIfAborted();
  await ensureDirectory(join(home, "schedules"));
  const root = planDirectory(home, id);
  await mkdir(root, { mode: 0o700 });
  const temporary = await mkdtemp(join(root, ".create-"));
  try {
    for (const [name, value] of [
      ["plan.json", scheduleDefinitionSchema.parse(definition)],
      ["meta.json", planMetaSchema.parse(meta)],
    ] satisfies [string, unknown][]) {
      const staged = join(temporary, name);
      await writeFile(staged, JSON.stringify(value, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
        signal: context.abortSignal,
      });
      context.abortSignal?.throwIfAborted();
      // meta.json 最后发布；扫描器不接纳尚未完成创建的目录。
      await link(staged, join(root, name));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function readPlanMeta(home: string, id: PlanId) {
  return planMetaSchema.parse(await readJson(metaPath(home, id)));
}
export async function writePlanMeta(
  home: string,
  id: PlanId,
  meta: PlanMeta,
  context: Context,
) {
  const path = metaPath(home, id);
  await readPlanMeta(home, id);
  const temporary = await mkdtemp(join(dirname(path), ".meta-"));
  try {
    const staged = join(temporary, "meta.json");
    await writeFile(
      staged,
      JSON.stringify(planMetaSchema.parse(meta), null, 2) + "\n",
      { flag: "wx", mode: 0o600, signal: context.abortSignal },
    );
    context.abortSignal?.throwIfAborted();
    await rename(staged, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function readScheduleFile(path: string) {
  const definition = scheduleDefinitionSchema.parse(await readJson(path));
  if (definition.when.kind === "cron") nextCron(definition.when, 0);
  return { ...definition, cwd: resolve(dirname(path), definition.cwd) };
}
export async function scanPlans(home: string) {
  const root = join(home, "schedules");
  let entries;
  try {
    z.literal(true).parse((await lstat(root)).isDirectory());
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  const plans: { id: PlanId; meta: PlanMeta }[] = [];
  for (const entry of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const id = planIdSchema.safeParse(entry.name);
    if (!id.success) continue;
    z.literal(true).parse(entry.isDirectory());
    try {
      plans.push({ id: id.data, meta: await readPlanMeta(home, id.data) });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  return plans;
}
