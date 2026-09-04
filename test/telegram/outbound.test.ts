import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AbortController, type AbortSignal } from "abort-controller";
import type { InputFile } from "grammy";
import type { PiTelegramOutboundRequest } from "../../src/bridge/agent-manager";
import { compilePiPrompt } from "../../src/bridge/prompt-compiler";
import { StateStore } from "../../src/state";
import {
  TELEGRAM_DOCUMENT_LIMIT_BYTES,
  TELEGRAM_PHOTO_LIMIT_BYTES,
  TelegramOutboundSender,
  type TelegramOutboundApi,
  type TelegramOutboundStateStore,
} from "../../src/telegram/outbound";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class RecordingApi implements TelegramOutboundApi {
  readonly calls: Array<{
    kind: "document" | "photo";
    chatId: number;
    options: {
      caption?: string;
      reply_parameters: {
        message_id: number;
        allow_sending_without_reply: true;
      };
    };
    signal?: AbortSignal;
  }> = [];
  documentError: unknown;
  photoError: unknown;

  async sendDocument(
    chatId: number,
    _document: InputFile,
    options: {
      caption?: string;
      reply_parameters: {
        message_id: number;
        allow_sending_without_reply: true;
      };
    },
    signal?: AbortSignal,
  ) {
    this.calls.push({
      kind: "document",
      chatId,
      options,
      ...(signal ? { signal } : {}),
    });
    if (this.documentError !== undefined) {
      throw this.documentError;
    }
    return {
      message_id: 501,
      date: 1_700_000_000,
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 12,
      },
    };
  }

  async sendPhoto(
    chatId: number,
    _photo: InputFile,
    options: {
      caption?: string;
      reply_parameters: {
        message_id: number;
        allow_sending_without_reply: true;
      };
    },
    signal?: AbortSignal,
  ) {
    this.calls.push({
      kind: "photo",
      chatId,
      options,
      ...(signal ? { signal } : {}),
    });
    if (this.photoError !== undefined) {
      throw this.photoError;
    }
    return {
      message_id: 502,
      date: 1_700_000_001,
      photo: [
        {
          file_id: "photo-small",
          file_unique_id: "photo-small-unique",
          width: 90,
          height: 60,
          file_size: 100,
        },
        {
          file_id: "photo-large",
          file_unique_id: "photo-large-unique",
          width: 900,
          height: 600,
          file_size: 1_000,
        },
      ],
    };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "amadeus-outbound-"));
  temporaryDirectories.push(root);
  const stateStore = await StateStore.open(join(root, "state.json"));
  const api = new RecordingApi();
  return {
    root,
    stateStore,
    api,
    sender: new TelegramOutboundSender({ api, stateStore, rootDir: root }),
  };
}

function request(
  path: string,
  kind: "document" | "photo" = "document",
  caption?: string,
): PiTelegramOutboundRequest {
  return {
    chatId: 123,
    replyToMessageId: 77,
    sessionId: "session-1",
    piEntryId: "entry-1",
    revision: 4,
    toolCallId: "tool-1",
    toolName:
      kind === "document" ? "telegram_send_document" : "telegram_send_photo",
    kind,
    args: { path, ...(caption !== undefined ? { caption } : {}) },
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

async function outboundSnapshotFiles(root: string): Promise<string[]> {
  return await readdir(join(root, ".amadeus-outbound", "123")).catch(() => []);
}

function pngHeader(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

describe("TelegramOutboundSender", () => {
  test("发送 document 后先持久化完整回复索引", async () => {
    const { root, stateStore, api, sender } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");

    const result = await sender.send(
      request("report.pdf", "document", "Report"),
    );

    expect(result).toMatchObject({
      status: "sent",
      kind: "document",
      messageId: 501,
      indexed: true,
      fileName: "report.pdf",
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      kind: "document",
      chatId: 123,
      options: {
        caption: "Report",
        reply_parameters: {
          message_id: 77,
          allow_sending_without_reply: true,
        },
      },
    });
    expect(stateStore.snapshot().chats["123"]?.messages["501"]).toMatchObject({
      messageId: 501,
      role: "assistant",
      piSessionId: "session-1",
      piEntryId: "entry-1",
      text: "Report",
      content: { kind: "document" },
      attachments: [
        {
          kind: "document",
          fileId: "doc-file-id",
          fileUniqueId: "doc-unique-id",
          localPath: expect.stringContaining(
            join(root, ".amadeus-outbound", "123"),
          ),
        },
      ],
    });
  });

  test("用户 reply 出站文件时可用 Pi entry 恢复当前 session 上下文", async () => {
    const { root, stateStore, sender } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    await sender.send(request("report.pdf", "document", "Report"));
    const chat = stateStore.snapshot().chats["123"];
    if (!chat) {
      throw new Error("缺少 chat 状态");
    }

    const compiled = await compilePiPrompt(
      {
        updateId: 2,
        chatId: 123,
        messageId: 503,
        sentAt: "2026-01-01T00:00:00.000Z",
        sender: { id: 7, displayName: "User" },
        text: "这个文件是什么？",
        reply: { messageId: 501 },
        attachments: [],
      },
      "session-1",
      chat,
      {
        download: async () => {
          throw new Error("当前 session reply 不应重新下载附件");
        },
      },
    );

    expect(compiled.message).toContain(
      '<ref role="assistant" id="501" entry="entry-1"/>',
    );
  });

  test("发送 photo 并索引 Telegram 返回的最大尺寸", async () => {
    const { root, stateStore, api, sender } = await fixture();
    await writeFile(join(root, "image.png"), pngHeader());

    const result = await sender.send(request("image.png", "photo"));

    expect(result).toMatchObject({
      status: "sent",
      kind: "photo",
      messageId: 502,
      indexed: true,
      mimeType: "image/png",
    });
    expect(api.calls[0]?.kind).toBe("photo");
    expect(stateStore.snapshot().chats["123"]?.messages["502"]).toMatchObject({
      attachments: [
        {
          kind: "photo",
          fileId: "photo-large",
          width: 900,
          height: 600,
          mimeType: "image/png",
          localPath: expect.stringContaining(
            join(root, ".amadeus-outbound", "123"),
          ),
        },
      ],
    });
  });

  test("拒绝 URL、目录、越界 realpath 和过长 caption", async () => {
    const { root, api, sender } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "amadeus-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    await mkdir(join(root, "folder"));

    const cases: Array<[PiTelegramOutboundRequest, string]> = [
      [request("https://example.com/file.pdf"), "url_not_allowed"],
      [request("folder"), "not_regular_file"],
      [request("escape.txt"), "path_outside_root"],
      [request("missing.txt"), "file_not_found"],
      [
        request("missing.txt", "document", "x".repeat(1025)),
        "caption_too_long",
      ],
    ];
    for (const [item, code] of cases) {
      await expect(sender.send(item)).resolves.toMatchObject({
        status: "rejected",
        code,
      });
    }
    expect(api.calls).toHaveLength(0);
  });

  test("document 和 photo 精确接受上限并拒绝上限加一字节", async () => {
    const { root, api, sender } = await fixture();
    const documentAtLimit = join(root, "at-limit.bin");
    const documentTooLarge = join(root, "too-large.bin");
    const photoAtLimit = join(root, "at-limit.png");
    const photoTooLarge = join(root, "too-large.png");
    await writeFile(documentAtLimit, "x");
    await writeFile(documentTooLarge, "x");
    await writeFile(photoAtLimit, pngHeader());
    await writeFile(photoTooLarge, pngHeader());
    await Promise.all([
      truncate(documentAtLimit, TELEGRAM_DOCUMENT_LIMIT_BYTES),
      truncate(documentTooLarge, TELEGRAM_DOCUMENT_LIMIT_BYTES + 1),
      truncate(photoAtLimit, TELEGRAM_PHOTO_LIMIT_BYTES),
      truncate(photoTooLarge, TELEGRAM_PHOTO_LIMIT_BYTES + 1),
    ]);

    await expect(sender.send(request("at-limit.bin"))).resolves.toMatchObject({
      status: "sent",
    });
    await expect(sender.send(request("too-large.bin"))).resolves.toMatchObject({
      status: "rejected",
      code: "document_too_large",
    });
    await expect(
      sender.send(request("at-limit.png", "photo")),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      sender.send(request("too-large.png", "photo")),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "photo_too_large",
    });
    expect(api.calls).toHaveLength(2);
  });

  test("photo 拒绝不是 JPEG、PNG 或 WebP 的普通文件", async () => {
    const { root, api, sender } = await fixture();
    await writeFile(join(root, "not-image.txt"), "plain text");

    await expect(
      sender.send(request("not-image.txt", "photo")),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "unsupported_photo_format",
    });
    expect(api.calls).toHaveLength(0);
  });

  test("校验后路径被替换时仍上传已打开的同一个文件", async () => {
    const { root, stateStore } = await fixture();
    const path = join(root, "report.txt");
    await writeFile(path, "validated-content");
    let uploaded = "";
    const api: TelegramOutboundApi = {
      sendDocument: async (_chatId, input) => {
        await rename(path, join(root, "original.txt"));
        await writeFile(path, "replacement-content");
        const raw = await input.toRaw();
        if (raw instanceof Uint8Array) {
          uploaded = new TextDecoder().decode(raw);
        } else {
          const chunks: Uint8Array[] = [];
          for await (const chunk of raw) {
            chunks.push(chunk);
          }
          uploaded = new TextDecoder().decode(
            Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
          );
        }
        return {
          message_id: 504,
          date: 1_700_000_002,
          document: {
            file_id: "fixed-file",
            file_unique_id: "fixed-unique",
          },
        };
      },
      sendPhoto: async () => {
        throw new Error("unreachable");
      },
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
    });

    await expect(sender.send(request("report.txt"))).resolves.toMatchObject({
      status: "sent",
    });
    expect(uploaded).toBe("validated-content");
    const indexed = stateStore.snapshot().chats["123"]?.messages["504"];
    const localPath = indexed?.attachments[0]?.localPath;
    expect(localPath).toBeDefined();
    expect(localPath).not.toBe(path);
    expect(await readFile(localPath ?? "", "utf8")).toBe("validated-content");
  });

  test("宿主总 deadline 在上传前到期时不会调用 Telegram", async () => {
    const { root, api, sender } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    const item = request("report.pdf");
    item.deadlineAt = Date.now() - 1;

    await expect(sender.send(item)).resolves.toMatchObject({
      status: "rejected",
      code: "delivery_preparation_timeout",
    });
    expect(api.calls).toHaveLength(0);
    expect(await outboundSnapshotFiles(root)).toEqual([]);
  });

  test("Telegram 明确 4xx 返回 rejected，传输错误返回 unknown", async () => {
    const { root, api, sender } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");

    api.documentError = { error_code: 400 };
    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "rejected",
      code: "telegram_rejected",
    });

    expect(await outboundSnapshotFiles(root)).toEqual([]);

    api.documentError = new Error("socket closed");
    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "unknown",
      code: "telegram_delivery_unknown",
    });
    expect(await outboundSnapshotFiles(root)).toEqual([]);
  });

  test("revision signal 会中止在途上传并返回 unknown", async () => {
    const { root, stateStore } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    const revision = new AbortController();
    const item = request("report.pdf");
    item.signal = revision.signal;
    let calls = 0;
    const api: TelegramOutboundApi = {
      sendDocument: async (_chatId, _file, _options, signal) => {
        calls += 1;
        revision.abort();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        throw new Error("unreachable");
      },
      sendPhoto: async () => {
        throw new Error("unreachable");
      },
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
    });

    await expect(sender.send(item)).resolves.toMatchObject({
      status: "unknown",
      code: "telegram_delivery_unknown",
    });
    expect(calls).toBe(1);
  });

  test("请求超时返回 unknown，不自动重发", async () => {
    const { root, stateStore } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    let calls = 0;
    const api: TelegramOutboundApi = {
      sendDocument: async () => {
        calls += 1;
        return await new Promise<never>(() => undefined);
      },
      sendPhoto: async () => {
        throw new Error("unreachable");
      },
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
      requestTimeoutMs: 5,
    });

    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "unknown",
      code: "telegram_delivery_timeout",
    });
    expect(calls).toBe(1);
    expect(await outboundSnapshotFiles(root)).toEqual([]);
  });

  test("close 会等待在途上传并拒绝新发送", async () => {
    const { root, stateStore } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    let signal: AbortSignal | undefined;
    let releaseUpload: (() => void) | undefined;
    const uploadPending = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const api: TelegramOutboundApi = {
      sendDocument: async (_chatId, _file, _options, requestSignal) => {
        signal = requestSignal;
        await uploadPending;
        return {
          message_id: 501,
          date: 1_700_000_000,
          document: {
            file_id: "doc-file-id",
            file_unique_id: "doc-unique-id",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            file_size: 12,
          },
        };
      },
      sendPhoto: async () => {
        throw new Error("unreachable");
      },
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
    });

    const sending = sender.send(request("report.pdf"));
    while (!signal) {
      await Bun.sleep(1);
    }
    const closing = sender.close();
    const closedEarly = await Promise.race([
      closing.then(() => true),
      Bun.sleep(10).then(() => false),
    ]);

    expect(closedEarly).toBeFalse();
    expect(signal.aborted).toBeFalse();
    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "rejected",
      code: "service_stopping",
    });
    releaseUpload?.();
    await expect(sending).resolves.toMatchObject({ status: "sent" });
    await closing;
  });

  test("状态持久化超时后 close 会排空已接受的迟到成功", async () => {
    const { root, api } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    let releaseUpdate: (() => void) | undefined;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const stateStore: TelegramOutboundStateStore = {
      update: async () => updateGate,
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
      stateTimeoutMs: 5,
    });

    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "unknown",
      telegramSent: true,
      messageId: 501,
      code: "state_persist_timeout",
    });
    const closing = sender.close();
    expect(
      await Promise.race([
        closing.then(() => true),
        Bun.sleep(10).then(() => false),
      ]),
    ).toBeFalse();
    releaseUpdate?.();
    await closing;
    expect(await outboundSnapshotFiles(root)).toHaveLength(1);
  });

  test("状态持久化超时后迟到失败会清理快照并完成关闭", async () => {
    const { root, api } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    let rejectUpdate: ((error: Error) => void) | undefined;
    const updateGate = new Promise<void>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    const stateStore: TelegramOutboundStateStore = {
      update: async () => updateGate,
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
      stateTimeoutMs: 5,
    });

    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "unknown",
      telegramSent: true,
      messageId: 501,
      code: "state_persist_timeout",
    });
    expect(await outboundSnapshotFiles(root)).toHaveLength(1);
    const closing = sender.close();
    rejectUpdate?.(new Error("disk full after timeout"));
    await closing;
    expect(await outboundSnapshotFiles(root)).toEqual([]);
  });

  test("Telegram 已发送但状态写入失败时不向 Pi 返回成功", async () => {
    const { root, api } = await fixture();
    await writeFile(join(root, "report.pdf"), "%PDF-content");
    const stateStore: TelegramOutboundStateStore = {
      update: async () => {
        throw new Error("disk full");
      },
    };
    const sender = new TelegramOutboundSender({
      api,
      stateStore,
      rootDir: root,
    });

    await expect(sender.send(request("report.pdf"))).resolves.toMatchObject({
      status: "unknown",
      telegramSent: true,
      messageId: 501,
      code: "state_persist_failed",
    });
    expect(api.calls).toHaveLength(1);
    expect(await outboundSnapshotFiles(root)).toEqual([]);
  });
});
