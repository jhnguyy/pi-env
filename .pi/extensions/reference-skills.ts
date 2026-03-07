/**
 * Reference Skills Tool
 *
 * Exposes a tool the LLM can call to discover and load skills from
 * ~/.agents/skills/reference/ — skills that aren't in passive context.
 *
 * Call with no name to list available skills.
 * Call with a name to load that skill's content.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REFERENCE_DIR = path.join(os.homedir(), ".agents", "skills", "reference");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "reference_skill",
    label: "Reference Skill",
    description:
      "Access skills that are not in passive context. Call without a name to list available skills, or with a name to load that skill's instructions.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Skill name to load. Omit to list available skills." })
      ),
    }),

    async execute(_toolCallId, params) {
      if (!fs.existsSync(REFERENCE_DIR)) {
        return {
          content: [{ type: "text", text: `Reference skill directory not found: ${REFERENCE_DIR}` }],
        };
      }

      const files = fs.readdirSync(REFERENCE_DIR).filter((f) => f.endsWith(".md"));

      // List mode
      if (!params.name) {
        const names = files.map((f) => f.replace(/\.md$/, ""));
        return {
          content: [
            {
              type: "text",
              text: `Available reference skills:\n${names.map((n) => `  - ${n}`).join("\n")}`,
            },
          ],
        };
      }

      // Load mode — fuzzy match on filename or frontmatter name
      const target = params.name.toLowerCase();
      let matched: string | null = null;

      for (const file of files) {
        const filePath = path.join(REFERENCE_DIR, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+?)\s*$/m);
        const skillName = nameMatch ? nameMatch[1].trim().toLowerCase() : file.replace(/\.md$/, "");

        if (skillName === target || file.replace(/\.md$/, "").toLowerCase() === target) {
          matched = filePath;
          break;
        }
      }

      if (!matched) {
        const names = files.map((f) => f.replace(/\.md$/, ""));
        return {
          content: [
            {
              type: "text",
              text: `No reference skill named "${params.name}". Available: ${names.join(", ")}`,
            },
          ],
        };
      }

      const content = fs.readFileSync(matched, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    },
  });
}
