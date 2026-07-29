import { z } from "zod";
import { parse as parseYaml } from "yaml";

export type GithubAiLinterRule = {
  files: string[];
  invariant: string;
};

export type GithubAiLinterRules = Record<string, GithubAiLinterRule>;

export type GithubAiLinterRuleSource = {
  paths: string[];
  repoPath: string;
};

const RuleMetadata = z.object({
  files: z.array(z.string().min(1)).min(1),
  id: z.string().regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/),
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
  if (paths.length === 0) {
    throw new Error(`GitHub AI linter has no configured rule paths for ${source.repoPath}`);
  }

  const firstPath = paths[0]!;
  const firstFile = await repo.readFile({ path: firstPath });
  if (firstFile === null) {
    throw new Error(`GitHub AI linter rule does not exist: ${source.repoPath}:${firstPath}`);
  }
  const files = [[firstPath, firstFile] as const];
  for (const path of paths.slice(1)) {
    const file = await repo.readFile({ commitOid: firstFile.commitOid, path });
    if (file === null) {
      throw new Error(`GitHub AI linter rule does not exist: ${source.repoPath}:${path}`);
    }
    files.push([path, file] as const);
  }

  const rules: GithubAiLinterRules = {};
  for (const [path, file] of files) {
    const rule = parseGithubAiLinterRule(path, file.content);
    if (Object.hasOwn(rules, rule.id)) {
      throw new Error(`Duplicate GitHub AI linter rule id "${rule.id}" in ${path}`);
    }
    rules[rule.id] = { files: rule.files, invariant: rule.invariant };
  }
  return rules;
}

function parseGithubAiLinterRule(path: string, content: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (frontmatter === null) {
    throw new Error(`GitHub AI linter rule ${path} needs frontmatter with id and files`);
  }
  let metadata: z.infer<typeof RuleMetadata>;
  try {
    metadata = RuleMetadata.parse(parseYaml(frontmatter[1]!));
  } catch (cause) {
    throw new Error(`GitHub AI linter rule ${path} has invalid frontmatter`, { cause });
  }
  const invariant = frontmatter[2]!.trim();
  if (invariant.length === 0) throw new Error(`GitHub AI linter rule ${path} has no body`);
  return { ...metadata, invariant };
}
