import { constants } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES } from "../telegram/types";

export const MAX_AUDIO_BYTES = TELEGRAM_PUBLIC_FILE_DOWNLOAD_LIMIT_BYTES;

export class AudioConversionError extends Error {
  constructor(
    readonly code: "conversion_failed" | "audio_too_large" | "audio_too_long",
  ) {
    super(code);
  }
}

export interface AudioConverter {
  convert(
    path: string,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export class FfmpegAudioConverter implements AudioConverter {
  constructor(
    private readonly command: string,
    private readonly attachmentsDir: string,
  ) {}

  async convert(
    path: string,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const root = await realpath(this.attachmentsDir);
    const resolved = await realpath(path);
    const inside = relative(root, resolved);
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith("../") ||
      isAbsolute(inside)
    )
      throw new AudioConversionError("conversion_failed");
    const file = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let input: Uint8Array;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new AudioConversionError("conversion_failed");
      if (info.size > MAX_AUDIO_BYTES)
        throw new AudioConversionError("audio_too_large");
      const buffer = Buffer.alloc(MAX_AUDIO_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          total,
          buffer.length - total,
          null,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > MAX_AUDIO_BYTES)
        throw new AudioConversionError("audio_too_large");
      input = buffer.subarray(0, total);
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "amadeus-stt-"));
    try {
      const output = join(directory, "audio.flac");
      const process = Bun.spawn(
        [
          this.command,
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "pipe",
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-threads",
          "1",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "flac",
          "-t",
          String(maxDurationSeconds + 1),
          "-fs",
          String(MAX_AUDIO_BYTES),
          "-stats_period",
          "3600",
          "-progress",
          "pipe:1",
          "-y",
          output,
        ],
        { stdin: input, stdout: "pipe", stderr: "ignore" },
      );
      const abort = (): void => {
        process.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const [exitCode, progress] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
        ]);
        signal.throwIfAborted();
        if (exitCode !== 0) throw new AudioConversionError("conversion_failed");
        const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
        const duration = Number(times.at(-1)?.[1]);
        if (!Number.isFinite(duration) || duration <= 0)
          throw new AudioConversionError("conversion_failed");
        if (duration > maxDurationSeconds * 1_000_000)
          throw new AudioConversionError("audio_too_long");
        if ((await stat(output)).size >= MAX_AUDIO_BYTES)
          throw new AudioConversionError("audio_too_large");
        return await readFile(output);
      } finally {
        signal.removeEventListener("abort", abort);
        process.kill("SIGKILL");
        await process.exited;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
