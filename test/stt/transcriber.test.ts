import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, hasSeenMessage } from "../../src/state";
import {
  TelegramVoiceTranscriber,
  type TranscriptionApi,
} from "../../src/stt/transcriber";
import type { AudioConverter } from "../../src/stt/ffmpeg";
import type { TelegramAttachment } from "../../src/telegram/types";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const config = {
  enabled: true,
  apiKey: "fake-key",
  model: "microsoft/mai-transcribe-2",
  ffmpegCommand: "ffmpeg",
  timeoutMs: 1000,
  maxDurationSeconds: 600,
} as const;
const voice = {
  kind: "voice",
  fileId: "voice-id",
  fileUniqueId: "voice-unique",
  duration: 1,
  mimeType: "audio/ogg",
  localPath: "/fixture/voice.ogg",
} satisfies TelegramAttachment;
const converter: AudioConverter = {
  convert: async () => new Uint8Array([1, 2, 3]),
};
async function store() {
  const root = await mkdtemp(join(tmpdir(), "amadeus-stt-test-"));
  roots.push(root);
  return { root, state: await StateStore.open(join(root, "state.json")) };
}

test("转录在交付前缓存，并跨重启复用而不提前标记消息已接收", async () => {
  const { root, state } = await store();
  let calls = 0;
  const api: TranscriptionApi = {
    transcribe: async (_audio, model) => {
      calls++;
      expect(model).toBe(config.model);
      return "合成测试文本";
    },
  };
  const stt = new TelegramVoiceTranscriber(config, state, converter, api);
  const [first, second] = await Promise.all([
    stt.transcribe(voice, 1, 1),
    stt.transcribe(voice, 1, 1),
  ]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ status: "completed", text: "合成测试文本" });
  expect(hasSeenMessage(state.snapshot().chats["1"], 1)).toBeFalse();
  await stt.close();
  const restarted = new TelegramVoiceTranscriber(
    config,
    await StateStore.open(join(root, "state.json")),
    converter,
    api,
  );
  expect(await restarted.transcribe(voice, 1, 1)).toEqual(first);
  expect(calls).toBe(1);
  await restarted.close();
});

test.each([
  ["", "empty_transcript"],
  [" \n ", "empty_transcript"],
  ["中".repeat(18000), "response_too_large"],
])("空或过大响应不会变成成功", async (text, code) => {
  const { state } = await store();
  const stt = new TelegramVoiceTranscriber(config, state, converter, {
    transcribe: async () => text,
  });
  expect(await stt.transcribe(voice, 1, 1)).toMatchObject({
    status: "unavailable",
    code,
  });
  await stt.close();
});

test("API 失败只返回固定状态，不暴露异常正文且不自动重试", async () => {
  const { state } = await store();
  let calls = 0;
  const stt = new TelegramVoiceTranscriber(config, state, converter, {
    transcribe: async () => {
      calls++;
      throw new Error("synthetic-private-error");
    },
  });
  const result = await stt.transcribe(voice, 1, 1);
  expect(result).toMatchObject({
    status: "unavailable",
    code: "request_failed",
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
  await stt.transcribe(voice, 1, 1);
  expect(calls).toBe(1);
  await stt.close();
});

test.each([false, true])(
  "超时后 close 排空忽略 signal 的 API，迟到拒绝=%s",
  async (reject) => {
    const { state } = await store();
    const gate = Promise.withResolvers<string>();
    let signal: AbortSignal | undefined;
    const stt = new TelegramVoiceTranscriber(
      { ...config, timeoutMs: 10 },
      state,
      converter,
      {
        transcribe: async (_audio, _model, s) => {
          signal = s;
          return gate.promise;
        },
      },
    );
    expect(await stt.transcribe(voice, 1, 1)).toMatchObject({
      status: "unavailable",
      code: "timeout",
    });
    expect(signal?.aborted).toBeTrue();
    const closing = stt.close();
    expect(
      await Promise.race([
        closing.then(() => true),
        Bun.sleep(10).then(() => false),
      ]),
    ).toBeFalse();
    if (reject) gate.reject(new Error("synthetic-late-error"));
    else gate.resolve("late text");
    await closing;
    expect(
      state.snapshot().chats["1"]?.voiceTranscriptions?.["1"]?.result.status,
    ).toBe("unavailable");
  },
);

test("超时转码完成后不迟到请求 API，关闭等待转码清理", async () => {
  const { state } = await store();
  const gate = Promise.withResolvers<Uint8Array>();
  let calls = 0;
  const stt = new TelegramVoiceTranscriber(
    { ...config, timeoutMs: 5 },
    state,
    { convert: async () => gate.promise },
    {
      transcribe: async () => {
        calls++;
        return "unexpected";
      },
    },
  );
  expect(await stt.transcribe(voice, 1, 1)).toMatchObject({ code: "timeout" });
  const closing = stt.close();
  gate.resolve(new Uint8Array());
  await closing;
  expect(calls).toBe(0);
});

test("不可用、过大、过长附件不启动转码或请求", async () => {
  const { state } = await store();
  let calls = 0;
  const stt = new TelegramVoiceTranscriber(
    config,
    state,
    {
      convert: async () => {
        calls++;
        throw new Error("unreachable");
      },
    },
    {
      transcribe: async () => {
        throw new Error("unreachable");
      },
    },
  );
  const { localPath: _path, ...unavailable } = voice;
  expect(await stt.transcribe(unavailable, 1, 1)).toMatchObject({
    code: "audio_unavailable",
  });
  expect(
    await stt.transcribe({ ...voice, size: 21 * 1024 * 1024 }, 1, 2),
  ).toMatchObject({ code: "audio_too_large" });
  expect(await stt.transcribe({ ...voice, duration: 601 }, 1, 3)).toMatchObject(
    { code: "audio_too_long" },
  );
  expect(calls).toBe(0);
  await stt.close();
});

test("禁用 STT 不要求 FFmpeg，启用但命令缺失时明确报错", async () => {
  const { state } = await store();
  expect(
    TelegramVoiceTranscriber.create({ enabled: false }, state, "/fixture"),
  ).toBeUndefined();
  expect(() =>
    TelegramVoiceTranscriber.create(
      { ...config, ffmpegCommand: "amadeus-nonexistent-ffmpeg-test" },
      state,
      "/fixture",
    ),
  ).toThrow("STT requires FFmpeg");
});
