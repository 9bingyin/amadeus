import telegramifyMarkdown from "telegramify-markdown";

export interface TelegramMarkdownChunk {
  source: string;
  markdownV2: string;
}

const TELEGRAM_TEXT_LIMIT = 4096;

export function splitTelegramMarkdown(
  markdown: string,
  limit = TELEGRAM_TEXT_LIMIT,
): TelegramMarkdownChunk[] {
  if (limit < 32) {
    throw new Error("Telegram 文本分段限制过小");
  }

  const blocks = splitBlocks(markdown).flatMap((block) =>
    splitOversizedBlock(block, limit),
  );
  const chunks: TelegramMarkdownChunk[] = [];
  let source = "";
  let formatted = "";

  for (const block of blocks) {
    const blockFormatted = convert(block);
    const sourceCandidate =
      source.length === 0 ? block : `${source}\n\n${block}`;
    const formattedCandidate =
      formatted.length === 0
        ? blockFormatted
        : `${formatted}\n\n${blockFormatted}`;

    if (formattedCandidate.length <= limit) {
      source = sourceCandidate;
      formatted = formattedCandidate;
      continue;
    }

    if (formatted.length > 0) {
      chunks.push({ source, markdownV2: formatted });
    }
    source = block;
    formatted = blockFormatted;
  }

  if (formatted.length > 0) {
    chunks.push({ source, markdownV2: formatted });
  }
  return chunks;
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const block = current.join("\n").trimEnd();
    if (block.length > 0) {
      blocks.push(block);
    }
    current = [];
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inFence && current.length > 0) {
        flush();
      }
      current.push(line);
      inFence = !inFence;
      if (!inFence) {
        flush();
      }
      continue;
    }

    if (!inFence && line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function splitOversizedBlock(block: string, limit: number): string[] {
  if (convert(block).length <= limit) {
    return [block];
  }

  const fence = parseFence(block);
  if (fence) {
    return splitFencedCode(fence.language, fence.content, limit);
  }
  return splitPlainBlock(block, limit);
}

function splitPlainBlock(block: string, limit: number): string[] {
  const parts: string[] = [];
  let remaining = block;

  while (remaining.length > 0) {
    const end = largestFittingPrefix(
      remaining,
      limit,
      (part) => convert(part).length,
    );
    const preferredEnd = preferredBreak(remaining, end);
    const part = remaining.slice(0, preferredEnd).trimEnd();
    if (part.length === 0) {
      throw new Error("无法分割 Telegram Markdown 文本");
    }
    parts.push(part);
    remaining = remaining.slice(preferredEnd).trimStart();
  }
  return parts;
}

function splitFencedCode(
  language: string,
  content: string,
  limit: number,
): string[] {
  const parts: string[] = [];
  let remaining = content;
  const wrap = (part: string): string => `\`\`\`${language}\n${part}\n\`\`\``;

  while (remaining.length > 0) {
    const end = largestFittingPrefix(
      remaining,
      limit,
      (part) => convert(wrap(part)).length,
    );
    const preferredEnd = preferredBreak(remaining, end);
    const part = remaining.slice(0, preferredEnd);
    if (part.length === 0) {
      throw new Error("无法分割 Telegram 代码块");
    }
    parts.push(wrap(part));
    remaining = remaining.slice(preferredEnd);
  }
  return parts;
}

function largestFittingPrefix(
  value: string,
  limit: number,
  measure: (part: string) => number,
): number {
  let low = 1;
  let high = value.length;
  let best = 0;

  while (low <= high) {
    const middle = safeUtf16End(value, Math.floor((low + high) / 2));
    if (middle <= best) {
      low = Math.floor((low + high) / 2) + 1;
      continue;
    }
    if (measure(value.slice(0, middle)) <= limit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best === 0) {
    throw new Error("单个字符超过 Telegram 文本限制");
  }
  return best;
}

function preferredBreak(value: string, maximum: number): number {
  if (maximum >= value.length) {
    return value.length;
  }
  const minimum = Math.floor(maximum * 0.6);
  const candidate = value.slice(minimum, maximum);
  const newline = candidate.lastIndexOf("\n");
  if (newline >= 0) {
    return safeUtf16End(value, minimum + newline + 1);
  }
  const space = candidate.lastIndexOf(" ");
  if (space >= 0) {
    return safeUtf16End(value, minimum + space + 1);
  }
  return safeUtf16End(value, maximum);
}

function safeUtf16End(value: string, end: number): number {
  if (end <= 0 || end >= value.length) {
    return end;
  }
  const previous = value.charCodeAt(end - 1);
  const current = value.charCodeAt(end);
  return isHighSurrogate(previous) && isLowSurrogate(current) ? end - 1 : end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function parseFence(
  block: string,
): { language: string; content: string } | undefined {
  const match = /^```([^\n]*)\n([\s\S]*?)\n```$/.exec(block);
  if (!match) {
    return undefined;
  }
  return {
    language: (match[1] ?? "").slice(0, 32),
    content: match[2] ?? "",
  };
}

function convert(markdown: string): string {
  return telegramifyMarkdown(markdown, "escape").trim();
}
