import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { MessageEntity } from "grammy/types";
import { renderMarkdown, splitMessage } from "telegram-md-entities";

export type FormattedMessage = JsonRepresentation<{
  text: string;
  entities: MessageEntity[];
}>;

export function formatReply(
  text: string,
  streaming = false,
): FormattedMessage[] {
  const chunks = splitMessage(
    renderMarkdown(text, { streaming, underline: false }),
  );
  // 库的实体类型把 url/language 统一声明为可选；生成结果遵循 Bot API，适配 grammY 的判别联合。
  return chunks.filter((chunk) => chunk.text.length > 0) as FormattedMessage[];
}
