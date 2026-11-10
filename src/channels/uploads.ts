import { fileTypeFromFile } from "file-type";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

export type Upload = {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
};

function uploadName(id: string, name: string): string {
  const safe =
    basename(name.replaceAll("\\", "/"))
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/^\.+$/, "") || "attachment";
  let result = `${id}-`;
  // Linux 文件名组件最多 255 字节，保留完整原名作为展示元数据。
  for (const char of safe) {
    if (Buffer.byteLength(result + char) > 255) break;
    result += char;
  }
  return result;
}

export async function materializeUpload(
  directory: string,
  file: { id: string; name: string; mimeType: string; size: number | null },
  download: () => Promise<Response>,
  signal: AbortSignal,
): Promise<Upload> {
  signal.throwIfAborted();
  const path = join(directory, uploadName(file.id, file.name));
  const existing = await lstat(path).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return undefined;
  });
  if (existing?.isFile() && (file.size === null || existing.size === file.size))
    return {
      ...file,
      path,
      size: existing.size,
      mimeType:
        (await fileTypeFromFile(path, { signal }))?.mime ?? file.mimeType,
    };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = join(directory, `.${file.id}.partial`);
  try {
    const response = await download();
    if (!response.ok)
      throw (
        (await response.text()) ||
        response.statusText ||
        String(response.status)
      );
    let size: number;
    {
      await using output = await open(staging, "w", 0o600);
      size = await Bun.write(Bun.file(output.fd), response);
    }
    signal.throwIfAborted();
    if (file.size !== null) z.literal(file.size).parse(size);
    const mimeType =
      (await fileTypeFromFile(staging, { signal }))?.mime ?? file.mimeType;
    await rename(staging, path);
    return { ...file, path, size, mimeType };
  } finally {
    await rm(staging, { force: true });
  }
}
