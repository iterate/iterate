import { z } from "zod";
import { parse as parseYaml } from "yaml";

export type GithubAiLinterRule = {
  files: string[];
  invariant: string;
  severity: "error" | "warning";
  suggestions: "allowed" | "forbidden";
};

/**
 * One immutable rules snapshot. The commit is deliberately returned beside
 * the parsed rules: an analysis must be reproducible even if `/repos/config`
 * advances while the agent is reading the pull request.
 */
export type GithubAiLinterRules = {
  commitOid: string;
  rules: Record<string, GithubAiLinterRule>;
};

export type GithubAiLinterRuleSource = {
  paths: string[];
  repoPath: string;
};

const RuleMetadata = z.object({
  files: z.array(z.string().min(1)).min(1),
  id: z.string().regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/),
  severity: z.enum(["error", "warning"]),
  suggestions: z.enum(["allowed", "forbidden"]).default("allowed"),
});

type RulesProject = {
  repos: {
    get(path: string): {
      readFile(input: {
        commitOid?: string;
        path: string;
      }): Promise<{ commitOid: string; content: string } | null>;
    };
  };
};

export async function loadGithubAiLinterRules(
  itx: RulesProject,
  source: GithubAiLinterRuleSource,
): Promise<GithubAiLinterRules> {
  const repo = itx.repos.get(source.repoPath);
  const paths = [...new Set(source.paths)].toSorted();
  const firstPath = paths[0];
  if (firstPath === undefined) {
    throw new Error(`GitHub AI linter has no configured rule paths for ${source.repoPath}`);
  }
  const firstFile = await repo.readFile({ path: firstPath });
  if (firstFile === null) {
    throw new Error(`GitHub AI linter rule does not exist: ${source.repoPath}:${firstPath}`);
  }
  const files = new Map([[firstPath, firstFile]]);
  for (const path of paths.slice(1)) {
    const file = await repo.readFile({ commitOid: firstFile.commitOid, path });
    if (file === null) {
      throw new Error(`GitHub AI linter rule does not exist: ${source.repoPath}:${path}`);
    }
    files.set(path, file);
  }

  const rules: GithubAiLinterRules["rules"] = {};
  for (const [path, file] of files) {
    const rule = parseGithubAiLinterRule(path, file.content);
    if (Object.hasOwn(rules, rule.id)) {
      throw new Error(`Duplicate GitHub AI linter rule id "${rule.id}" in ${path}`);
    }
    rules[rule.id] = {
      files: rule.files,
      invariant: rule.invariant,
      severity: rule.severity,
      suggestions: rule.suggestions,
    };
  }
  return { commitOid: firstFile.commitOid, rules };
}

function parseGithubAiLinterRule(path: string, content: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  const metadataSource = frontmatter?.[1];
  const body = frontmatter?.[2];
  if (metadataSource === undefined || body === undefined) {
    throw new Error(`GitHub AI linter rule ${path} needs frontmatter with id, files, and severity`);
  }
  let metadata: z.infer<typeof RuleMetadata>;
  try {
    metadata = RuleMetadata.parse(parseYaml(metadataSource));
  } catch (cause) {
    throw new Error(`GitHub AI linter rule ${path} has invalid frontmatter`, { cause });
  }
  const invariant = body.trim();
  if (invariant.length === 0) throw new Error(`GitHub AI linter rule ${path} has no body`);
  return { ...metadata, invariant };
}
