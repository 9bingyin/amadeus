import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

describe("插件运行时依赖", () => {
  test("Memory 插件的 value imports 都是直接 dependencies", async () => {
    const source = await readFile(
      join(root, "plugins/memory/index.ts"),
      "utf8",
    );
    const manifest: unknown = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      dependencies: {
        "@earendil-works/pi-ai": "0.84.4",
        "@earendil-works/pi-coding-agent": "0.84.4",
      },
    });
    expect(source).toContain('from "@earendil-works/pi-ai"');
    expect(source).toContain('from "@earendil-works/pi-coding-agent"');
  });
});
