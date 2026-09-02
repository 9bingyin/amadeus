export class StrictJsonlDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  #finished = false;

  push(chunk: Uint8Array): string[] {
    if (this.#finished) {
      throw new Error("JSONL 解码器已经结束");
    }
    return this.#append(this.#decoder.decode(chunk, { stream: true }));
  }

  finish(): string[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;
    const lines = this.#append(this.#decoder.decode());
    if (this.#buffer.length > 0) {
      throw new Error("Pi RPC 输出末行缺少 LF 分隔符");
    }
    return lines;
  }

  #append(text: string): string[] {
    if (text.includes("\r")) {
      throw new Error("Pi RPC JSONL 只能使用 LF，不能使用 CR 或 CRLF");
    }

    this.#buffer += text;
    const records = this.#buffer.split("\n");
    this.#buffer = records.pop() ?? "";

    for (const record of records) {
      if (record.length === 0) {
        throw new Error("Pi RPC JSONL 不能包含空行");
      }
    }
    return records;
  }
}
