// TODO: move to daemon oRPC after oRPC-ification

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

const Harness = z.enum(["claude-code", "opencode"]);
type Harness = z.infer<typeof Harness>;

/** Flatten path for Claude (can't handle nested). e.g. "cat/skill" -> "cat--skill" */
export const flattenPathForClaude = (p: string) => p.split("/").join("--");

const getTargetDir = (harness: Harness) =>
  harness === "claude-code"
    ? path.join(homedir(), ".claude", "skills")
    : path.join(homedir(), ".config", "opencode", "skills");

async function findSkills(skillsDir: string) {
  const skills: Array<{ relativePath: string; absolutePath: string }> = [];

  async function scan(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const relativePath = path.relative(skillsDir, dir);
      // Skip if SKILL.md is directly in skills/ root (empty path would clobber target dir)
      if (relativePath) {
        skills.push({ relativePath, absolutePath: dir });
        return;
      }
    }

    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        await scan(path.join(dir, e.name));
      }
    }
  }

  await scan(skillsDir);
  return skills;
}

async function isSymlinkTo(linkPath: string, target: string) {
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const linkTarget = await fs.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), linkTarget) === target;
  } catch {
    return false;
  }
}

async function pathExists(p: string) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export const skillsRouter = t.router({
  sync: t.procedure
    .meta({ description: "Sync agent skills to harness config locations" })
    .input(
      z.object({
        source: z.string().optional().describe("Source dir with skills/ folder (defaults to cwd)"),
        force: z.boolean().default(false).describe("Overwrite non-matching targets"),
        harnesses: z
          .array(Harness)
          .default(["claude-code", "opencode"])
          .describe("Target harnesses"),
        dryRun: z.boolean().default(false).describe("Preview without changes"),
      }),
    )
    .mutation(async ({ input }) => {
      // Resolve to absolute path to ensure symlinks work correctly
      const sourceDir = path.resolve(input.source || process.cwd());
      const skillsDir = path.join(sourceDir, "skills");

      try {
        const stat = await fs.stat(skillsDir);
        if (!stat.isDirectory()) return { success: false, error: `Not a directory: ${skillsDir}` };
      } catch {
        return { success: false, error: `Skills directory not found: ${skillsDir}` };
      }

      const skills = await findSkills(skillsDir);
      if (!skills.length) return { success: false, error: `No skills found in ${skillsDir}` };

      type Action = {
        skill: string;
        harness: Harness;
        target: string;
        absolutePath: string;
        action: "create" | "skip-exists" | "skip-same" | "overwrite";
        reason?: string;
      };
      const actions: Action[] = [];

      for (const harness of input.harnesses) {
        const targetDir = getTargetDir(harness);
        for (const { relativePath, absolutePath } of skills) {
          const targetName =
            harness === "claude-code" ? flattenPathForClaude(relativePath) : relativePath;
          const target = path.join(targetDir, targetName);
          const exists = await pathExists(target);
          const same = exists && (await isSymlinkTo(target, absolutePath));

          const action: Action["action"] = !exists
            ? "create"
            : same
              ? "skip-same"
              : input.force
                ? "overwrite"
                : "skip-exists";
          const reason = same
            ? "already linked"
            : exists && !input.force
              ? "exists (use --force)"
              : exists
                ? "--force"
                : undefined;

          actions.push({ skill: relativePath, harness, target, absolutePath, action, reason });
        }
      }

      if (input.dryRun) {
        return {
          success: true,
          dryRun: true,
          skillsFound: skills.length,
          actions: actions.map(({ absolutePath: _, ...a }) => a),
        };
      }

      const errors: Array<{ skill: string; harness: string; error: string }> = [];

      for (const a of actions) {
        if (a.action === "skip-same" || a.action === "skip-exists") continue;
        try {
          await fs.mkdir(path.dirname(a.target), { recursive: true });
          if (a.action === "overwrite") await fs.rm(a.target, { recursive: true, force: true });
          await fs.symlink(a.absolutePath, a.target);
        } catch (err) {
          errors.push({
            skill: a.skill,
            harness: a.harness,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        success: !errors.length,
        skillsFound: skills.length,
        actions: actions.map(({ absolutePath: _, ...a }) => a),
        errors: errors.length ? errors : undefined,
      };
    }),
});
