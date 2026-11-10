import type { ImageContent } from "@earendil-works/pi-ai";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { Api, Bot } from "grammy";
import { z } from "zod";
import type { LoadPhoto } from "./inbound";

const imageSchema = z.object({ data: z.string(), mimeType: z.string() });
// grammY 使用旧版 AbortSignal 声明；getFile 运行时兼容原生 signal。
type TelegramSignal = NonNullable<Parameters<Api["getFile"]>[1]>;

export function createPhotoLoader(bot: Bot): LoadPhoto {
  let images: ReturnType<typeof createNodePhotonImages> | undefined;
  return async (fileId, limits, signal): Promise<ImageContent> => {
    // 仅适配 grammY 的 AbortSignal 类型，取消仍由原生 signal 驱动。
    const file = await bot.api.getFile(fileId, signal as TelegramSignal);
    const path = z.string().min(1).parse(file.file_path);
    const root = bot.api.options?.apiRoot ?? "https://api.telegram.org";
    const environment = bot.api.options?.environment === "test" ? "test/" : "";
    // 带 token 的地址只用于当前下载，不保存进条目或发给模型。
    const response = await fetch(
      `${root}/file/bot${bot.token}/${environment}${path}`,
      { signal },
    );
    if (!response.ok)
      throw (
        (await response.text()) ||
        response.statusText ||
        String(response.status)
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const processor = await (images ??= createNodePhotonImages());
    const prepared = await processor.prepare(
      bytes,
      response.headers.get("content-type") ?? "image/jpeg",
      limits,
    );
    signal.throwIfAborted();
    return { type: "image", ...imageSchema.parse(prepared) };
  };
}
