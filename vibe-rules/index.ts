import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import { parse as parseYaml } from "yaml";
import type { PackageRuleItem } from "vibe-rules";

export function vibeRulesFromFiles(pattern: string): PackageRuleItem[] {
  try {
    const moduleDir = findModuleDirectory();
    if (!moduleDir) {
      throw new Error("Could not determine vibe-rules module directory");
    }

    const files = globSync(pattern, { cwd: moduleDir });

    return files.map((filePath) => {
      const fullPath = join(moduleDir, filePath);
      const content = readFileSync(fullPath, "utf-8");

      const parts = content.split("---");

      let frontmatter: Record<string, unknown> = {};
      let body = content;

      if (parts.length >= 3) {
        const frontmatterSection = parts[1]?.trim();
        body = parts.slice(2).join("---").trim();

        if (frontmatterSection) {
          try {
            frontmatter = parseYaml(frontmatterSection) || {};
          } catch (error) {
            console.warn(`Failed to parse YAML frontmatter in ${filePath}:`, error);
          }
        }
      }

      const name = basename(filePath, ".md");

      return {
        name,
        rule: body,
        ...frontmatter,
      } as PackageRuleItem;
    });
  } catch (error) {
    console.error(`Error reading vibe rules with pattern ${pattern}:`, error);
    return [];
  }
}

function findModuleDirectory(): string | null {
  try {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n");

    for (const line of lines) {
      const fileUrlMatch = line.match(/(file:\/\/[^\s)]+)/);
      if (fileUrlMatch) {
        const filePath = fileURLToPath(fileUrlMatch[1]);
        if (filePath.includes("vibe-rules")) {
          const parts = filePath.split("vibe-rules");
          if (parts[0]) {
            return join(parts[0], "vibe-rules");
          }
        }
      }

      const posixMatch = line.match(/(\/[^\s)]+\/vibe-rules)/);
      if (posixMatch) {
        return posixMatch[1];
      }
    }
  } catch {
    // Ignore call stack parsing errors
  }

  try {
    const currentFile = fileURLToPath(import.meta.url);
    return dirname(currentFile);
  } catch {
    return null;
  }
}
