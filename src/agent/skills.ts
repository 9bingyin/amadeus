import {
  formatSkillsForPrompt,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Config } from "../config";

export function createSkillsExtension(
  config: Pick<Config, "stateDirectory" | "workspace">,
) {
  const { skills, diagnostics } = loadSkills({
    agentDir: config.stateDirectory,
    cwd: config.workspace,
    skillPaths: [],
    includeDefaults: true,
  });
  for (const diagnostic of diagnostics) console.error(diagnostic);
  const prompt = formatSkillsForPrompt(skills);
  return defineExtension({
    name: "amadeus.skills",
    sections: [section("skills", () => prompt, { tag: false })],
  });
}
