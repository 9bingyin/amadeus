import { expect, test } from "bun:test";
import { ZodError } from "zod";
import { createAgentModels } from "../agent/models";
import { parseConfig } from ".";

test("配置保留安全边界，并以配置目录解析状态路径", async () => {
  const input: unknown = await Bun.file(
    new URL("../../config.example.json", import.meta.url),
  ).json();
  const config = parseConfig(input, "/tmp/amadeus");
  expect(config.stateDirectory).toBe("/tmp/amadeus/.amadeus");
  expect(() =>
    createAgentModels({ ...config.model, id: "unconfigured-custom-model" }),
  ).toThrow(ZodError);
  expect(() =>
    parseConfig({ ...config, telegram: { allowedUserIds: [] } }, "/tmp"),
  ).toThrow();
  expect(() =>
    parseConfig({ ...config, telegram: { allowedUserIds: [-1] } }, "/tmp"),
  ).toThrow();
  expect(() =>
    parseConfig({ ...config, stateDirectory: ".test_home/new" }, "/tmp"),
  ).toThrow(ZodError);
  expect(() =>
    parseConfig(
      { ...config, model: { id: "test", baseUrl: "file:///tmp/model" } },
      "/tmp",
    ),
  ).toThrow(ZodError);
});
