import { expect, test } from "bun:test";
import {
  OpenRouterTranscriptionApi,
  MAX_STT_RESPONSE_BYTES,
} from "../../src/stt/transcriber";

test("隔离进程中的 SDK 不继承调试、地址或应用标识环境变量", async () => {
  const modulePath = new URL("../../src/stt/transcriber.ts", import.meta.url)
    .href;
  const script = `
    import { strict as assert } from 'node:assert';
    import { OpenRouterTranscriptionApi } from ${JSON.stringify(modulePath)};
    const api = new OpenRouterTranscriptionApi('synthetic-private-key', async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
      assert.equal(request.headers.get('HTTP-Referer') ?? '', '');
      assert.equal(request.headers.get('X-OpenRouter-Title'), 'Amadeus');
      assert.equal(request.headers.get('X-OpenRouter-Categories') ?? '', '');
      return Response.json({text: 'synthetic-private-transcript'});
    });
    await api.transcribe(new Uint8Array([1,2,3]), 'microsoft/mai-transcribe-2', new AbortController().signal);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      OPENROUTER_DEBUG: "true",
      OPENROUTER_BASE_URL: "https://synthetic.example.invalid/v1",
      OPENROUTER_HTTP_REFERER: "synthetic-referrer",
      OPENROUTER_APP_TITLE: "synthetic-title",
      OPENROUTER_APP_CATEGORIES: "synthetic-categories",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test.each([200, 500])(
  "SDK 成功或错误响应均按实际读取字节限流并取消超大响应",
  async (status) => {
    let cancelled = false;
    let reads = 0;
    const api = new OpenRouterTranscriptionApi(
      "synthetic-key",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      api.transcribe(
        new Uint8Array(),
        "microsoft/mai-transcribe-2",
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(cancelled).toBeTrue();
    expect(reads).toBeLessThanOrEqual(6);
  },
);

test("SDK 拒绝正文很短但额外字段超大的 JSON 和超大长度声明", async () => {
  for (const headers of [
    {},
    { "content-length": String(MAX_STT_RESPONSE_BYTES + 1) },
  ]) {
    const api = new OpenRouterTranscriptionApi("synthetic-key", async () =>
      Response.json(
        { text: "short", extra: "x".repeat(MAX_STT_RESPONSE_BYTES) },
        { headers },
      ),
    );
    await expect(
      api.transcribe(
        new Uint8Array(),
        "microsoft/mai-transcribe-2",
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
  }
});

test("官方 SDK 发送 STT JSON、FLAC 与独立凭证，读取 text", async () => {
  const api = new OpenRouterTranscriptionApi(
    "synthetic-key",
    async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://openrouter.ai/api/v1/audio/transcriptions",
      );
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-key");
      expect(await request.json()).toEqual({
        model: "microsoft/mai-transcribe-2",
        input_audio: { data: "AQID", format: "flac" },
      });
      return Response.json({ text: "合成转录文本" });
    },
  );
  expect(
    await api.transcribe(
      new Uint8Array([1, 2, 3]),
      "microsoft/mai-transcribe-2",
      new AbortController().signal,
    ),
  ).toBe("合成转录文本");
});

test.each([400, 401, 402, 429, 500, 503])(
  "官方 SDK HTTP 失败不自动重试",
  async (status) => {
    let calls = 0;
    const api = new OpenRouterTranscriptionApi("synthetic-key", async () => {
      calls++;
      return Response.json(
        { error: { code: status, message: "synthetic-error" } },
        { status },
      );
    });
    await expect(
      api.transcribe(
        new Uint8Array(),
        "microsoft/mai-transcribe-2",
        new AbortController().signal,
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  },
);

test("官方 SDK 接收取消信号，网络异常不自动重试", async () => {
  let calls = 0;
  const controller = new AbortController();
  const api = new OpenRouterTranscriptionApi(
    "synthetic-key",
    async (input, init) => {
      calls++;
      const request = new Request(input, init);
      controller.abort();
      expect(request.signal.aborted).toBeTrue();
      throw new TypeError("synthetic-network-error");
    },
  );
  await expect(
    api.transcribe(
      new Uint8Array(),
      "microsoft/mai-transcribe-2",
      controller.signal,
    ),
  ).rejects.toBeDefined();
  expect(calls).toBe(1);
});
