import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ZodError } from "zod";
import { materializeUpload } from "./uploads";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amadeus-uploads-"));
  directories.push(root);
  return join(root, "uploads", "1");
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("持久附件使用安全文件名、私有权限和实际 MIME，完整文件恢复时不重复下载", async () => {
  const root = await directory();
  let downloads = 0;
  const file = {
    id: "42-0",
    name: "../../目录\\原图\n.jpg",
    mimeType: "image/jpeg",
    size: png.byteLength,
  };
  const load = () => {
    downloads++;
    return Promise.resolve(new Response(png));
  };
  const first = await materializeUpload(
    root,
    file,
    load,
    new AbortController().signal,
  );
  expect(first.name).toBe(file.name);
  expect(dirname(first.path)).toBe(root);
  expect(basename(first.path)).toBe("42-0-原图.jpg");
  expect(first.mimeType).toBe("image/png");
  expect(await Bun.file(first.path).bytes()).toEqual(new Uint8Array(png));
  expect((await stat(first.path)).mode & 0o777).toBe(0o600);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await stat(dirname(root))).mode & 0o777).toBe(0o700);
  expect(await readdir(root)).toEqual([basename(first.path)]);
  expect(
    await materializeUpload(root, file, load, new AbortController().signal),
  ).toEqual(first);
  expect(downloads).toBe(1);
});

test("长 Unicode 文件名不超过文件系统组件长度，原名不丢失", async () => {
  const root = await directory();
  const name = "报告".repeat(100) + ".txt";
  const saved = await materializeUpload(
    root,
    { id: "42-0", name, mimeType: "text/plain", size: 3 },
    () => Promise.resolve(new Response("abc")),
    new AbortController().signal,
  );
  expect(saved.name).toBe(name);
  expect(Buffer.byteLength(basename(saved.path))).toBeLessThanOrEqual(255);
  expect(await Bun.file(saved.path).text()).toBe("abc");
  expect(await readdir(root)).toEqual([basename(saved.path)]);
});

test("下载中断或大小不符不暴露半个附件，并清理临时文件", async () => {
  const root = await directory();
  const controller = new AbortController();
  const consuming = Promise.withResolvers<void>();
  const reason = new DOMException("cancel", "AbortError");
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(reason), {
        once: true,
      });
    },
    pull(stream) {
      if (++pulls === 1) stream.enqueue(new TextEncoder().encode("partial"));
      else consuming.resolve();
    },
  });
  const pending = materializeUpload(
    root,
    { id: "42-0", name: "file.txt", mimeType: "text/plain", size: null },
    () => Promise.resolve(new Response(stream)),
    controller.signal,
  ).catch((error: unknown) => error);
  await consuming.promise;
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(await readdir(root)).toEqual([]);
  await expect(
    materializeUpload(
      root,
      { id: "42-1", name: "file.txt", mimeType: "text/plain", size: 10 },
      () => Promise.resolve(new Response("short")),
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ZodError);
  expect(await readdir(root)).toEqual([]);
});
