import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
  ImageLimits,
  ImageProcessor,
} from "@earendil-works/pi-durable/tools";
import type { Api, Bot } from "grammy";
import { join } from "node:path";
import { z } from "zod";
import { materializeUpload, type Upload } from "../uploads";
import type { RemoteFile } from "./metadata";

// grammY 使用旧版 AbortSignal 声明；getFile 运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["getFile"]>[1]>;

export type AttachmentLoader = {
  load(
    file: RemoteFile,
    conversation: ConversationId,
    id: string,
    signal: AbortSignal,
  ): Promise<Upload>;
  image(
    file: Upload,
    limits: ImageLimits,
    signal: AbortSignal,
  ): Promise<ImageContent | null>;
};

export function createAttachmentLoader(
  bot: Bot,
  directory: string,
  images: ImageProcessor,
): AttachmentLoader {
  return {
    load: (source, conversation, id, signal) =>
      materializeUpload(
        join(directory, String(conversation)),
        { id, name: source.name, mimeType: source.mimeType, size: source.size },
        async () => {
          // 仅适配 grammY 的 AbortSignal 类型，取消仍由原生 signal 驱动。
          const file = await bot.api.getFile(
            source.fileId,
            signal as TelegramSignal,
          );
          const path = z.string().min(1).parse(file.file_path);
          const root = bot.api.options?.apiRoot ?? "https://api.telegram.org";
          const environment =
            bot.api.options?.environment === "test" ? "test/" : "";
          // 带 token 的下载地址只用于当前请求，不保存进附件或模型输入。
          return fetch(`${root}/file/bot${bot.token}/${environment}${path}`, {
            signal,
          });
        },
        signal,
      ),
    image: async (file, limits, signal) => {
      signal.throwIfAborted();
      const prepared = await images.prepare(
        await Bun.file(file.path).bytes(),
        file.mimeType,
        limits,
      );
      signal.throwIfAborted();
      return prepared
        ? { type: "image", data: prepared.data, mimeType: prepared.mimeType }
        : null;
    },
  };
}
