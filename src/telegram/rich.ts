import type {
  RichBlock,
  RichBlockCaption,
  RichMessage,
  RichMessageButton,
  RichText,
} from "grammy/types";

export interface NormalizedRichMessage {
  text: string;
  blockTypes: string[];
  unavailableBlockCount: number;
  unavailableReasons: Array<"unsupported_nested_type" | "missing_fields">;
}

const KNOWN_RICH_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "pre",
  "footer",
  "divider",
  "mathematical_expression",
  "anchor",
  "list",
  "blockquote",
  "expandable_blockquote",
  "pullquote",
  "collage",
  "slideshow",
  "buttons",
  "table",
  "details",
  "map",
  "animation",
  "audio",
  "document",
  "photo",
  "video",
  "voice_note",
  "thinking",
]);

export function normalizeRichMessage(rich: RichMessage): NormalizedRichMessage {
  const unavailableBlockCount = richBlocksIssueCount(rich.blocks);
  return {
    text: renderRichBlocks(rich.blocks),
    blockTypes: collectRichBlockTypes(rich.blocks),
    unavailableBlockCount,
    unavailableReasons:
      unavailableBlockCount > 0
        ? ["unsupported_nested_type", "missing_fields"]
        : [],
  };
}

export function collectRichBlockTypes(blocks: readonly RichBlock[]): string[] {
  return blocks.flatMap((block) => [
    richBlockType(block),
    ...nestedRichBlocks(block).flatMap((nested) =>
      collectRichBlockTypes(nested),
    ),
  ]);
}

function renderRichBlocks(blocks: readonly RichBlock[]): string {
  return blocks
    .map(renderRichBlock)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function renderRichBlock(block: RichBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderRichText(block.text);
    case "heading":
      return `${"#".repeat(block.size)} ${renderRichText(block.text)}`;
    case "pre":
      return `\`\`\`${block.language ?? ""}\n${renderRichText(block.text)}\n\`\`\``;
    case "footer":
      return renderRichText(block.text);
    case "divider":
      return "---";
    case "mathematical_expression":
      return `$$${block.expression}$$`;
    case "anchor":
      return `[anchor:${block.name}]`;
    case "list":
      return block.items
        .map((item) => {
          const marker = item.has_checkbox
            ? item.is_checked
              ? "- [x]"
              : "- [ ]"
            : item.label || "-";
          return `${marker} ${indent(renderRichBlocks(item.blocks))}`;
        })
        .join("\n");
    case "blockquote":
      return quote(joinCredit(renderRichBlocks(block.blocks), block.credit));
    case "expandable_blockquote":
      return quote(joinCredit(renderRichText(block.text), block.credit));
    case "pullquote":
      return quote(joinCredit(renderRichText(block.text), block.credit));
    case "collage":
      return joinCaption(renderRichBlocks(block.blocks), block.caption);
    case "slideshow":
      return joinCaption(renderRichBlocks(block.blocks), block.caption);
    case "buttons":
      return block.buttons.map(renderRichButton).join(" | ");
    case "table": {
      const rows = block.cells.map((row) =>
        row.map((cell) => renderRichText(cell.text ?? "")).join(" | "),
      );
      return [
        ...(block.caption ? [renderRichText(block.caption)] : []),
        ...rows,
      ].join("\n");
    }
    case "details":
      return `${renderRichText(block.summary)}\n${indent(renderRichBlocks(block.blocks))}`;
    case "map":
      return joinCaption(
        `[map: ${block.location.latitude}, ${block.location.longitude}; zoom=${block.zoom}]`,
        block.caption,
      );
    case "animation":
    case "audio":
    case "document":
    case "photo":
    case "video":
    case "voice_note":
      return joinCaption(`[${block.type}]`, block.caption);
    case "thinking":
      return renderRichText(block.text);
    default: {
      const exhaustive: never = block;
      return unsupportedRichNode("block", exhaustive);
    }
  }
}

function renderRichText(text: RichText): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text.map(renderRichText).join("");
  }

  switch (text.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
    case "spoiler":
    case "subscript":
    case "superscript":
    case "marked":
    case "code":
      return renderRichText(text.text);
    case "date_time":
      return `${renderRichText(text.text)} (${text.unix_time})`;
    case "text_mention":
      return appendTarget(
        renderRichText(text.text),
        text.user.username
          ? `@${text.user.username}`
          : `tg://user?id=${text.user.id}`,
      );
    case "custom_emoji":
      return text.alternative_text;
    case "mathematical_expression":
      return `$${text.expression}$`;
    case "url":
      return appendTarget(renderRichText(text.text), text.url);
    case "email_address":
      return appendTarget(renderRichText(text.text), text.email_address);
    case "phone_number":
      return appendTarget(renderRichText(text.text), text.phone_number);
    case "bank_card_number":
      return appendTarget(renderRichText(text.text), text.bank_card_number);
    case "mention":
      return appendTarget(renderRichText(text.text), text.username);
    case "hashtag":
      return appendTarget(renderRichText(text.text), text.hashtag);
    case "cashtag":
      return appendTarget(renderRichText(text.text), text.cashtag);
    case "bot_command":
      return appendTarget(renderRichText(text.text), text.bot_command);
    case "button":
      return renderRichButton(text.button);
    case "anchor":
      return `[anchor:${text.name}]`;
    case "anchor_link":
      return appendTarget(renderRichText(text.text), `#${text.anchor_name}`);
    case "reference":
      return `${renderRichText(text.text)} [reference:${text.name}]`;
    case "reference_link":
      return appendTarget(
        renderRichText(text.text),
        `reference:${text.reference_name}`,
      );
    default: {
      const exhaustive: never = text;
      return unsupportedRichNode("text", exhaustive);
    }
  }
}

function renderRichButton(button: RichMessageButton): string {
  const label = renderRichText(button.text);
  return "url" in button ? appendTarget(label, button.url) : label;
}

function nestedRichBlocks(block: RichBlock): readonly (readonly RichBlock[])[] {
  switch (block.type) {
    case "list":
      return block.items.map((item) => item.blocks);
    case "blockquote":
    case "collage":
    case "slideshow":
    case "details":
      return [block.blocks];
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "divider":
    case "mathematical_expression":
    case "anchor":
    case "expandable_blockquote":
    case "pullquote":
    case "buttons":
    case "table":
    case "map":
    case "animation":
    case "audio":
    case "document":
    case "photo":
    case "video":
    case "voice_note":
    case "thinking":
      return [];
    default: {
      const exhaustive: never = block;
      unsupportedRichNode("block", exhaustive);
      return [];
    }
  }
}

function richBlockType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string"
    ? value.type
    : "unknown";
}

function richBlocksIssueCount(blocks: readonly unknown[]): number {
  return blocks.reduce<number>(
    (count, block) => count + richBlockIssueCount(block),
    0,
  );
}

function richBlockIssueCount(value: unknown): number {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !KNOWN_RICH_BLOCK_TYPES.has(value.type)
  ) {
    return 1;
  }
  const block = value as unknown as RichBlock;
  switch (block.type) {
    case "paragraph":
    case "footer":
    case "thinking":
      return richTextIssueCount(block.text);
    case "heading":
      return (
        richTextIssueCount(block.text) + (Number.isInteger(block.size) ? 0 : 1)
      );
    case "pre":
      return richTextIssueCount(block.text);
    case "divider":
      return 0;
    case "mathematical_expression":
      return typeof block.expression === "string" ? 0 : 1;
    case "anchor":
      return typeof block.name === "string" ? 0 : 1;
    case "list":
      return Array.isArray(block.items)
        ? block.items.reduce(
            (count, item) =>
              count +
              (Array.isArray(item.blocks)
                ? richBlocksIssueCount(item.blocks)
                : 1),
            0,
          )
        : 1;
    case "blockquote":
      return (
        (Array.isArray(block.blocks) ? richBlocksIssueCount(block.blocks) : 1) +
        richTextIssueCount(block.credit, true)
      );
    case "expandable_blockquote":
    case "pullquote":
      return (
        richTextIssueCount(block.text) + richTextIssueCount(block.credit, true)
      );
    case "collage":
    case "slideshow":
      return (
        (Array.isArray(block.blocks) ? richBlocksIssueCount(block.blocks) : 1) +
        richCaptionIssueCount(block.caption)
      );
    case "buttons":
      return Array.isArray(block.buttons)
        ? block.buttons.reduce(
            (count, button) => count + richTextIssueCount(button.text),
            0,
          )
        : 1;
    case "table":
      return Array.isArray(block.cells)
        ? block.cells
            .flat()
            .reduce(
              (count, cell) => count + richTextIssueCount(cell.text, true),
              richTextIssueCount(block.caption, true),
            )
        : 1;
    case "details":
      return (
        richTextIssueCount(block.summary) +
        (Array.isArray(block.blocks) ? richBlocksIssueCount(block.blocks) : 1)
      );
    case "map":
      return (
        (Number.isFinite(block.location?.latitude) &&
        Number.isFinite(block.location?.longitude)
          ? 0
          : 1) + richCaptionIssueCount(block.caption)
      );
    case "photo":
      return (
        (Array.isArray(block.photo) && block.photo.some(isRichFileLike)
          ? 0
          : 1) + richCaptionIssueCount(block.caption)
      );
    case "animation":
      return richFileBlockIssueCount(block.animation, block.caption);
    case "audio":
      return richFileBlockIssueCount(block.audio, block.caption);
    case "document":
      return richFileBlockIssueCount(block.document, block.caption);
    case "video":
      return richFileBlockIssueCount(block.video, block.caption);
    case "voice_note":
      return richFileBlockIssueCount(block.voice_note, block.caption);
    default: {
      const exhaustive: never = block;
      return unsupportedRichNode("block", exhaustive).length > 0 ? 1 : 0;
    }
  }
}

function richFileBlockIssueCount(
  file: unknown,
  caption: RichBlockCaption | undefined,
): number {
  return (isRichFileLike(file) ? 0 : 1) + richCaptionIssueCount(caption);
}

function isRichFileLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.file_id === "string" &&
    value.file_id.length > 0 &&
    typeof value.file_unique_id === "string" &&
    value.file_unique_id.length > 0
  );
}

function richCaptionIssueCount(caption: unknown): number {
  if (caption === undefined) {
    return 0;
  }
  return isRecord(caption)
    ? richTextIssueCount(caption.text) +
        richTextIssueCount(caption.credit, true)
    : 1;
}

function richTextIssueCount(value: unknown, optional = false): number {
  if (value === undefined) {
    return optional ? 0 : 1;
  }
  if (typeof value === "string") {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + richTextIssueCount(item), 0);
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return 1;
  }

  switch (value.type) {
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
    case "spoiler":
    case "date_time":
    case "text_mention":
    case "subscript":
    case "superscript":
    case "marked":
    case "code":
    case "url":
    case "email_address":
    case "phone_number":
    case "bank_card_number":
    case "mention":
    case "hashtag":
    case "cashtag":
    case "bot_command":
    case "anchor_link":
    case "reference":
    case "reference_link":
      return richTextIssueCount(value.text);
    case "custom_emoji":
      return typeof value.alternative_text === "string" ? 0 : 1;
    case "mathematical_expression":
      return typeof value.expression === "string" ? 0 : 1;
    case "button":
      return isRecord(value.button) ? richTextIssueCount(value.button.text) : 1;
    case "anchor":
      return typeof value.name === "string" ? 0 : 1;
    default:
      return 1;
  }
}

function unsupportedRichNode(kind: "block" | "text", _value: never): string {
  return `[unsupported rich ${kind}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinCaption(
  text: string,
  caption: RichBlockCaption | undefined,
): string {
  if (!caption) {
    return text;
  }
  return joinCredit(`${text}\n${renderRichText(caption.text)}`, caption.credit);
}

function joinCredit(text: string, credit: RichText | undefined): string {
  return credit ? `${text}\n— ${renderRichText(credit)}` : text;
}

function appendTarget(label: string, target: string): string {
  return label === target ? label : `${label} (${target})`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
}
