import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FfmpegAudioConverter } from "../../src/stt/ffmpeg";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(duration = "0.2") {
  const root = await mkdtemp(join(tmpdir(), "amadeus-stt-ffmpeg-test-"));
  roots.push(root);
  const path = join(root, "voice.ogg");
  const process = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      duration,
      "-c:a",
      "libopus",
      path,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await process.exited).toBe(0);
  return { root, path, converter: new FfmpegAudioConverter("ffmpeg", root) };
}

test("真实 FFmpeg 将合成 OGG/Opus 转为 FLAC，原文件保持不变", async () => {
  const { path, converter } = await fixture();
  const original = await readFile(path);
  const flac = await converter.convert(path, 2, new AbortController().signal);
  expect(Buffer.from(flac).subarray(0, 4).toString()).toBe("fLaC");
  expect(await readFile(path)).toEqual(original);
});

test("实际语音超长会拒绝，而不是静默转录截断片段", async () => {
  const { path, converter } = await fixture("2");
  await expect(
    converter.convert(path, 1, new AbortController().signal),
  ).rejects.toMatchObject({ code: "audio_too_long" });
});

test("损坏音频、目录外符号链接和预先取消不会进入成功路径", async () => {
  const { root, converter } = await fixture();
  const bad = join(root, "bad.ogg");
  await writeFile(bad, "synthetic-invalid-audio");
  await expect(
    converter.convert(bad, 2, new AbortController().signal),
  ).rejects.toMatchObject({ code: "conversion_failed" });
  const outside = await fixture();
  const link = join(root, "outside.ogg");
  await symlink(outside.path, link);
  await expect(
    converter.convert(link, 2, new AbortController().signal),
  ).rejects.toMatchObject({ code: "conversion_failed" });
  await expect(
    converter.convert(bad, 2, AbortSignal.abort()),
  ).rejects.toBeDefined();
});

test("取消正在运行的转码会终止子进程并删除临时目录", async () => {
  const { root, path } = await fixture();
  const marker = join(root, "started.json");
  const command = join(root, "fake-ffmpeg");
  await writeFile(
    command,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, output: process.argv.at(-1) }));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const operation = new FfmpegAudioConverter(command, root).convert(
    path,
    2,
    controller.signal,
  );
  const settled = operation.catch(() => undefined);
  let value: unknown;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        value = JSON.parse(await readFile(marker, "utf8"));
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
  } finally {
    controller.abort();
  }
  await settled;
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("output" in value) ||
    typeof value.output !== "string"
  )
    throw new Error("fake converter did not start");
  const pid = value.pid;
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(stat(join(value.output, ".."))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(operation).rejects.toBeDefined();
});
