import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  markTelegramAttachmentUnavailable,
  TelegramDownloadError,
  TelegramFileDownloader,
  telegramDownloadUnavailableReason,
} from "../../src/telegram/download";
import {
  TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES,
  type TelegramAttachment,
} from "../../src/telegram/types";
import { RecordingLogger } from "../helpers/recording-logger";

const temporaryDirectories: string[] = [];

const downloadableAttachments: TelegramAttachment[] = [
  {
    kind: "animation",
    fileId: "animation",
    fileUniqueId: "animation-u",
    width: 640,
    height: 360,
    duration: 3,
  },
  {
    kind: "audio",
    fileId: "audio",
    fileUniqueId: "audio-u",
    duration: 42,
    fileName: "song.mp3",
  },
  {
    kind: "document",
    fileId: "document",
    fileUniqueId: "document-u",
    fileName: "report.pdf",
  },
  {
    kind: "live_photo",
    fileId: "live-photo",
    fileUniqueId: "live-photo-u",
    width: 1080,
    height: 1920,
    duration: 3,
  },
  {
    kind: "photo",
    fileId: "photo",
    fileUniqueId: "photo-u",
    width: 1280,
    height: 720,
  },
  {
    kind: "sticker",
    fileId: "sticker",
    fileUniqueId: "sticker-u",
    width: 512,
    height: 512,
    stickerType: "regular",
    format: "static",
  },
  {
    kind: "video",
    fileId: "video",
    fileUniqueId: "video-u",
    width: 1920,
    height: 1080,
    duration: 30,
  },
  {
    kind: "video_note",
    fileId: "video-note",
    fileUniqueId: "video-note-u",
    length: 384,
    duration: 15,
  },
  {
    kind: "voice",
    fileId: "voice",
    fileUniqueId: "voice-u",
    duration: 8,
  },
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("TelegramFileDownloader", () => {
  test("voice 下载响应体停滞会取消 reader 并清理 part 文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "amadeus-voice-download-"));
    temporaryDirectories.push(root);
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "voice.ogg" }) },
      botToken: "synthetic-token",
      downloadsDir: root,
      voiceTimeoutMs: 20,
      fetch: async (_input, init) => {
        signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
    });
    const voice = {
      kind: "voice",
      fileId: "voice-id",
      fileUniqueId: "voice-unique",
      duration: 1,
    } satisfies TelegramAttachment;
    await expect(downloader.download(voice, 1, 1)).rejects.toBeDefined();
    expect(signal?.aborted).toBeTrue();
    expect(cancelled).toBeTrue();
    expect(await readdir(join(root, "1"))).toEqual([]);
  });

  test.each(["metadata", "fetch"])(
    "voice 下载连接及 getFile 等待都接收总期限信号",
    async (stage) => {
      const root = await mkdtemp(join(tmpdir(), "amadeus-voice-connect-"));
      temporaryDirectories.push(root);
      const wait = (signal: AbortSignal | null | undefined): Promise<never> =>
        new Promise((_resolve, reject) => {
          if (!signal) throw new Error("missing cancellation signal");
          if (signal.aborted) reject(new Error("cancelled"));
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      const downloader = new TelegramFileDownloader({
        api: {
          getFile: async (_id, signal) =>
            stage === "metadata" ? wait(signal) : { file_path: "voice.ogg" },
        },
        botToken: "synthetic-token",
        downloadsDir: root,
        voiceTimeoutMs: 10,
        fetch: async (_input, init) => wait(init?.signal),
      });
      await expect(
        downloader.download(
          {
            kind: "voice",
            fileId: "voice-id",
            fileUniqueId: "voice-unique",
            duration: 1,
          },
          1,
          1,
        ),
      ).rejects.toBeDefined();
    },
  );
  test("下载到受控 chat 目录并清理不安全文件名", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    const logger = new RecordingLogger();
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "documents/file_1.bin" }) },
      botToken: "secret-token",
      downloadsDir: directory,
      fetch: async () => new Response("payload"),
      logger,
    });

    const attachment = await downloader.download(
      {
        kind: "document",
        fileId: "file",
        fileUniqueId: "unique",
        fileName: "../../unsafe.exe",
        size: 7,
      },
      42,
      190,
    );

    expect(isAbsolute(attachment.localPath ?? "")).toBeTrue();
    expect(attachment.localPath).toStartWith(join(directory, "42"));
    expect(attachment.localPath).not.toContain("../");
    expect(await readFile(attachment.localPath ?? "", "utf8")).toBe("payload");
    expect(logger.events()).toEqual([
      "telegram_file_download_started",
      "telegram_file_download_succeeded",
    ]);
    expect(logger.entries[0]).toMatchObject({
      fields: {
        attachment_kind: "document",
        chat_id: 42,
        file_size_bytes: 7,
        file_unique_id: "unique",
        message_id: 190,
      },
    });
    expect(logger.entries[1]).toMatchObject({
      fields: { file_size_bytes: 7 },
    });
  });

  test("不可读缓存不会被当作成功下载", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    let fetchCalls = 0;
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "documents/cache.bin" }) },
      botToken: "token",
      downloadsDir: directory,
      fetch: async () => {
        fetchCalls += 1;
        if (fetchCalls > 1) {
          throw new Error("offline");
        }
        return new Response("payload");
      },
    });
    const source: TelegramAttachment = {
      kind: "document",
      fileId: "cache",
      fileUniqueId: "cache-u",
      fileName: "cache.bin",
    };
    const first = await downloader.download(source, 42, 191);
    if (!first.localPath) {
      throw new Error("预期首次下载产生本机路径");
    }
    await chmod(first.localPath, 0o000);

    try {
      await expect(downloader.download(source, 42, 191)).rejects.toMatchObject({
        code: "network",
      });
      expect(fetchCalls).toBe(2);
    } finally {
      await chmod(first.localPath, 0o600);
    }
  });

  test("所有可下载媒体都写入绝对路径", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async (fileId) => ({ file_path: `media/${fileId}.bin` }),
      },
      botToken: "token",
      downloadsDir: directory,
      fetch: async () => new Response("payload"),
    });

    for (const [index, source] of downloadableAttachments.entries()) {
      const attachment = await downloader.download(source, 7, index + 1);
      expect(isAbsolute(attachment.localPath ?? "")).toBeTrue();
      expect(attachment.localPath).toStartWith(join(directory, "7"));
    }
  });

  test("下载成功后补齐实际大小和 MIME", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "documents/report.bin" }) },
      botToken: "token",
      downloadsDir: directory,
      fetch: async () =>
        new Response("payload", {
          headers: { "content-type": "application/pdf; charset=binary" },
        }),
    });

    const attachment = await downloader.download(
      {
        kind: "document",
        fileId: "document",
        fileUniqueId: "document-u",
        mimeType: "not a mime",
      },
      1,
      1,
    );

    expect(attachment).toMatchObject({
      size: 7,
      mimeType: "application/pdf",
    });
    expect(isAbsolute(attachment.localPath ?? "")).toBeTrue();
  });

  test("未知声明大小时按实际响应体执行 20 MiB 上限", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    const chunk = new Uint8Array(10 * 1024 * 1024);
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "documents/large.bin" }) },
      botToken: "token",
      downloadsDir: directory,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        ),
    });

    await expect(
      downloader.download(
        {
          kind: "document",
          fileId: "unknown-size",
          fileUniqueId: "unknown-size-u",
        },
        1,
        1,
      ),
    ).rejects.toMatchObject({
      code: "too_large",
      reason: "response_too_large",
    });
  });

  test("Content-Length 超限时立即拒绝", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-download-"));
    temporaryDirectories.push(directory);
    const downloader = new TelegramFileDownloader({
      api: { getFile: async () => ({ file_path: "documents/large.bin" }) },
      botToken: "token",
      downloadsDir: directory,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.close();
            },
          }),
          {
            headers: {
              "content-length": String(
                TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES + 1,
              ),
            },
          },
        ),
    });

    await expect(
      downloader.download(
        {
          kind: "document",
          fileId: "declared-response",
          fileUniqueId: "declared-response-u",
        },
        1,
        1,
      ),
    ).rejects.toMatchObject({
      code: "too_large",
      reason: "response_too_large",
    });
  });

  test("所有可下载媒体都统一执行 20 MiB 上限", async () => {
    let getFileCalls = 0;
    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async () => {
          getFileCalls += 1;
          return { file_path: "unused" };
        },
      },
      botToken: "token",
      downloadsDir: "/tmp/unused-amadeus-download",
    });

    for (const source of downloadableAttachments) {
      const attachment = {
        ...source,
        size: TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES + 1,
      } as TelegramAttachment;
      await expect(downloader.download(attachment, 1, 1)).rejects.toMatchObject(
        { code: "too_large" },
      );
    }
    expect(getFileCalls).toBe(0);
  });

  test("所有可下载媒体失败时产生结构化 unavailable 原因", async () => {
    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async () => {
          throw new Error("offline");
        },
      },
      botToken: "token",
      downloadsDir: "/tmp/unused-amadeus-download",
    });

    for (const attachment of downloadableAttachments) {
      let error: unknown;
      try {
        await downloader.download(attachment, 1, 1);
      } catch (caught) {
        error = caught;
      }
      expect(
        markTelegramAttachmentUnavailable(attachment, error),
      ).toMatchObject({
        kind: attachment.kind,
        unavailableReason: "download_failed",
      });
    }
  });

  test("在调用 getFile 前拒绝明确超过公开 Bot API 限制的文件", async () => {
    let getFileCalled = false;
    const logger = new RecordingLogger();
    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async () => {
          getFileCalled = true;
          return { file_path: "file.exe" };
        },
      },
      botToken: "token",
      downloadsDir: "/tmp/unused-amadeus-download",
      logger,
    });

    const operation = downloader.download(
      {
        kind: "document",
        fileId: "large",
        fileUniqueId: "large-u",
        fileName: "large.exe",
        size: 24_472_432,
      },
      1,
      1,
    );

    await expect(operation).rejects.toBeInstanceOf(TelegramDownloadError);
    await expect(operation).rejects.toMatchObject({ code: "too_large" });
    expect(getFileCalled).toBeFalse();
    expect(logger.events()).toEqual([
      "telegram_file_download_started",
      "telegram_file_download_failed",
    ]);
    expect(logger.entries[1]).toMatchObject({
      fields: {
        error_name: "TelegramDownloadError",
        file_size_bytes: 24_472_432,
        reason: "declared_too_large",
      },
    });
  });

  test("图片超过 20 MiB 时也不调用 getFile", async () => {
    let getFileCalled = false;
    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async () => {
          getFileCalled = true;
          return { file_path: "photos/file.jpg" };
        },
      },
      botToken: "token",
      downloadsDir: "/tmp/unused-amadeus-download",
      logger: new RecordingLogger(),
    });

    const operation = downloader.download(
      {
        kind: "photo",
        fileId: "large-photo",
        fileUniqueId: "large-photo-u",
        width: 8000,
        height: 8000,
        size: 20 * 1024 * 1024 + 1,
      },
      1,
      2,
    );

    await expect(operation).rejects.toMatchObject({ code: "too_large" });
    expect(getFileCalled).toBeFalse();
  });

  test("把下载错误归一化为可写入 Agent prompt 的原因", () => {
    expect(
      telegramDownloadUnavailableReason(
        new TelegramDownloadError("too_large", "file is too big"),
      ),
    ).toBe("telegram_public_api_limit");
    expect(telegramDownloadUnavailableReason(new Error("network"))).toBe(
      "download_failed",
    );
  });
});
