// TODO: This should really be a daemon oRPC procedure after the big oRPC-ification

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { t } from "../trpc.ts";

// ============================================================================
// Types
// ============================================================================

const Harness = z.enum(["claude-code", "opencode"]);
type Harness = z.infer<typeof Harness>;

interface Skill {
  /** Relative path from source root, e.g. "category/skill-name" */
  relativePath: string;
  /** Absolute path to the skill folder */
  absolutePath: string;
  /** The skill name (folder containing SKILL.md) */
  name: string;
}

interface SyncAction {
  skill: Skill;
  harness: Harness;
  targetPath: string;
  /** What will happen */
  action: "create" | "skip-exists" | "skip-same" | "overwrite";
  /** Reason for skip/overwrite */
  reason?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Find all skills in source directory by scanning for *\/SKILL.md */
async function findSkills(sourceDir: string): Promise<Skill[]> {
  const skills: Skill[] = [];

  async function scanDir(dir: string, relativeTo: string) {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if this directory contains SKILL.md
    const hasSkillMd = entries.some(
      (e: import("node:fs").Dirent<string>) => e.isFile() && e.name === "SKILL.md",
    );
    if (hasSkillMd) {
      const relativePath = path.relative(relativeTo, dir);
      skills.push({
        relativePath,
        absolutePath: dir,
        name: path.basename(dir),
      });
      return; // Don't recurse into skill folders
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await scanDir(path.join(dir, entry.name), relativeTo);
      }
    }
  }

  await scanDir(sourceDir, sourceDir);
  return skills;
}

/**
 * Flatten a relative path for Claude Code (which can't handle nested skills).
 * Replaces path separators with double hyphens.
 * e.g. "category/skill-name" -> "category--skill-name"
 */
export function flattenPathForClaude(relativePath: string): string {
  return relativePath.split(path.sep).join("--");
}

/** Get target directory for a harness */
function getTargetDir(harness: Harness): string {
  switch (harness) {
    case "claude-code":
      return path.join(homedir(), ".claude", "skills");
    case "opencode":
      return path.join(homedir(), ".config", "opencode", "skills");
  }
}

/** Check if path is a symlink pointing to target */
async function isSymlinkTo(linkPath: string, target: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const linkTarget = await fs.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), linkTarget) === path.resolve(target);
  } catch {
    return false;
  }
}

/** Check if path exists (file, dir, or symlink) */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Plan sync actions for a harness */
async function planSync(skills: Skill[], harness: Harness, force: boolean): Promise<SyncAction[]> {
  const targetDir = getTargetDir(harness);
  const actions: SyncAction[] = [];

  for (const skill of skills) {
    // For Claude, flatten the path; for OpenCode, preserve structure
    const targetName =
      harness === "claude-code" ? flattenPathForClaude(skill.relativePath) : skill.relativePath;
    const targetPath = path.join(targetDir, targetName);

    // Check current state
    const exists = await pathExists(targetPath);
    const isSameSymlink = exists && (await isSymlinkTo(targetPath, skill.absolutePath));

    let action: SyncAction["action"];
    let reason: string | undefined;

    if (!exists) {
      action = "create";
    } else if (isSameSymlink) {
      action = "skip-same";
      reason = "already symlinked to same source";
    } else if (force) {
      action = "overwrite";
      reason = "target exists but --force specified";
    } else {
      action = "skip-exists";
      reason = "target exists (use --force to overwrite)";
    }

    actions.push({ skill, harness, targetPath, action, reason });
  }

  return actions;
}

/** Execute a sync action */
async function executeAction(action: SyncAction): Promise<void> {
  if (action.action === "skip-same" || action.action === "skip-exists") {
    return;
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(action.targetPath), { recursive: true });

  if (action.action === "overwrite") {
    // Remove existing (could be file, dir, or broken symlink)
    await fs.rm(action.targetPath, { recursive: true, force: true });
  }

  // Create symlink
  await fs.symlink(action.skill.absolutePath, action.targetPath);
}

// ============================================================================
// Router
// ============================================================================

export const skillsRouter = t.router({
  sync: t.procedure
    .meta({ description: "Sync agent skills from source directory to harness config locations" })
    .input(
      z.object({
        source: z
          .string()
          .optional()
          .describe("Source directory containing skills/ folder (defaults to cwd)"),
        force: z
          .boolean()
          .default(false)
          .describe("Overwrite existing targets that aren't symlinks to the same source"),
        harnesses: z
          .array(Harness)
          .default(["claude-code", "opencode"])
          .describe("Target harnesses to sync to"),
        dryRun: z.boolean().default(false).describe("Preview changes without making them"),
      }),
    )
    .mutation(async ({ input }) => {
      const sourceDir = input.source || process.cwd();
      const skillsDir = path.join(sourceDir, "skills");

      // Check if skills directory exists
      try {
        const stat = await fs.stat(skillsDir);
        if (!stat.isDirectory()) {
          return { success: false, error: `Not a directory: ${skillsDir}` };
        }
      } catch {
        return { success: false, error: `Skills directory not found: ${skillsDir}` };
      }

      // Find all skills
      const skills = await findSkills(skillsDir);
      if (skills.length === 0) {
        return { success: false, error: `No skills found in ${skillsDir}` };
      }

      // Plan actions for each harness
      const allActions: SyncAction[] = [];
      for (const harness of input.harnesses) {
        const actions = await planSync(skills, harness, input.force);
        allActions.push(...actions);
      }

      // Format results
      const results = allActions.map((a) => ({
        skill: a.skill.relativePath,
        harness: a.harness,
        target: a.targetPath,
        action: a.action,
        reason: a.reason,
      }));

      if (input.dryRun) {
        return {
          success: true,
          dryRun: true,
          skillsFound: skills.length,
          actions: results,
        };
      }

      // Execute actions
      const executed: typeof results = [];
      const errors: Array<{ skill: string; harness: string; error: string }> = [];

      for (const action of allActions) {
        try {
          await executeAction(action);
          executed.push({
            skill: action.skill.relativePath,
            harness: action.harness,
            target: action.targetPath,
            action: action.action,
            reason: action.reason,
          });
        } catch (err) {
          errors.push({
            skill: action.skill.relativePath,
            harness: action.harness,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        success: errors.length === 0,
        skillsFound: skills.length,
        actions: executed,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
});
