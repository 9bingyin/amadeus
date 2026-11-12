import { expect, test } from "bun:test";
import { formatReply } from "./format";

test("Treats double underscores as CommonMark bold, not underline", () => {
  const [message] = formatReply("__bold__");
  expect(message?.text).toBe("bold");
  expect(message?.entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
});

test("Enables incomplete Markdown in streaming previews", () => {
  const [message] = formatReply("**unfinished", true);
  expect(message?.text).toBe("unfinished");
  expect(message?.entities).toEqual([{ type: "bold", offset: 0, length: 10 }]);
});

test("Omits empty replies", () => {
  expect(formatReply("  \n\t")).toEqual([]);
});
