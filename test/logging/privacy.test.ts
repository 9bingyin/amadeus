import { afterEach, describe, expect, test } from "bun:test";
import { AbortController } from "abort-controller";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInfoLogger } from "../../src/logging/logger";
import { StateStore } from "../../src/state";
import { TelegramFileDownloader } from "../../src/telegram/download";
import { TelegramFinalReplySender } from "../../src/telegram/final-reply";
import { TelegramOutboundSender } from "../../src/telegram/outbound";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("日志敏感信息隔离", () => {
  test("文件和回复失败不输出 token、URL、正文、路径或 Error cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amadeus-log-privacy-"));
    temporaryDirectories.push(directory);
    const lines: string[] = [];
    const logger = createInfoLogger({
      now: () => new Date("2026-09-01T00:00:00Z"),
      writeLine: (line) => lines.push(line),
    });
    const token = "TEST_ONLY_BOT_TOKEN";
    const messageBody = "private Telegram body and quote";
    const localPath = "/home/private/session/content.jsonl";
    const base64 = "aW1hZ2UtYmFzZTY0LXNlY3JldA==";

    const downloader = new TelegramFileDownloader({
      api: {
        getFile: async () => ({ file_path: "private/server/path.bin" }),
      },
      botToken: token,
      downloadsDir: directory,
      logger,
      fetch: async (input) => {
        throw new Error(`fetch ${String(input)} ${messageBody} ${localPath}`, {
          cause: new Error(base64),
        });
      },
    });
    await expect(
      downloader.download(
        {
          kind: "document",
          fileId: "private-file-id",
          fileUniqueId: token,
          fileName: messageBody,
          size: 12,
        },
        1,
        2,
      ),
    ).rejects.toBeInstanceOf(Error);

    const stateStore = await StateStore.open(join(directory, "state.json"));
    const sender = new TelegramFinalReplySender(
      {
        sendMessage: async () => {
          throw new Error(`${token} ${messageBody} ${localPath}`, {
            cause: new Error(base64),
          });
        },
      },
      stateStore,
      logger,
    );
    await expect(
      sender.send({
        chatId: 1,
        replyToMessageId: 2,
        sessionId: "private-session-id",
        piEntryId: "private-entry-id",
        text: messageBody,
        stopReason: "stop",
      }),
    ).rejects.toBeInstanceOf(Error);

    const outboundPath = join(directory, "private-report-name.pdf");
    await writeFile(outboundPath, "%PDF-private-content");
    const outbound = new TelegramOutboundSender({
      api: {
        sendDocument: async () => {
          throw new Error(`${token} ${messageBody} ${localPath}`, {
            cause: new Error(base64),
          });
        },
        sendPhoto: async () => {
          throw new Error("not used");
        },
      },
      stateStore,
      rootDir: directory,
      logger,
    });
    await outbound.send({
      chatId: 1,
      replyToMessageId: 2,
      sessionId: "private-session-id",
      piEntryId: "private-entry-id",
      revision: 1,
      toolCallId: "private-tool-call-id",
      toolName: "telegram_send_document",
      kind: "document",
      args: { path: outboundPath, caption: messageBody },
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    const output = lines.join("\n");
    expect(output).toContain("event=telegram_file_download_failed");
    expect(output).toContain("event=telegram_reply_failed");
    for (const forbidden of [
      token,
      "api.telegram.org",
      messageBody,
      localPath,
      base64,
      "private-file-id",
      "private-session-id",
      "private-entry-id",
      "private/server/path.bin",
      "private-report-name.pdf",
      "private-tool-call-id",
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  test("业务源码不直接写控制台或继承 Pi stderr", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const files: string[] = [];
    for await (const path of glob.scan({ cwd: process.cwd() })) {
      files.push(path);
    }
    const source = (
      await Promise.all(files.map((path) => Bun.file(path).text()))
    ).join("\n");

    expect(source).not.toContain("console.log");
    expect(source).not.toContain("console.error");
    expect(source).not.toContain('stderr: "inherit"');
  });
});
