// Runs oxlint in fix mode with ONLY the iterate/no-pointless-casts rule enabled. The rule is
// too slow (adds ~40s of type-checking to a full-repo lint) to keep on for every `pnpm lint`,
// so it stays "off" in .oxlintrc.json and a scheduled workflow runs this script instead — see
// .github/ts-workflows/workflows/remove-pointless-casts.ts.
//
// Multiple passes: the rule only removes outermost casts per run (nested removals would be
// overlapping edits), so `walk(x as A) as B` needs a second pass to flag `x as A`.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const derivedConfigPath = resolve(repoRoot, ".oxlintrc.pointless-casts.ignoreme.json");

const writeSingleRuleConfig = (rule: string) => {
  const config = JSON.parse(readFileSync(resolve(repoRoot, ".oxlintrc.json"), "utf8"));
  for (const category of Object.keys(config.categories || {})) {
    config.categories[category] = "off";
  }
  for (const configRule of Object.keys(config.rules || {})) {
    config.rules[configRule] = "off";
  }
  config.rules[rule] = "error";
  for (const override of config.overrides || []) {
    for (const overrideRule of Object.keys(override.rules || {})) {
      override.rules[overrideRule] = "off";
    }
  }
  writeFileSync(derivedConfigPath, JSON.stringify(config, null, 2));
};

const runOxlintFix = (extraArgs: string[]) => {
  const result = spawnSync(
    "pnpm",
    ["exec", "oxlint", ".", "--fix", "--threads", "1", "--config", derivedConfigPath, ...extraArgs],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status;
};

try {
  writeSingleRuleConfig("iterate/no-pointless-casts");
  for (let pass = 1; pass <= 3; pass++) {
    console.log(`removing pointless casts (pass ${pass})`);
    // zero exit = no casts left to remove; nonzero = findings were fixed, go again in case
    // their removal exposed nested casts
    if (runOxlintFix([]) === 0) break;
  }

  // a removed cast can leave its type annotation's imports unused; clean those up. The unused
  // import fix is classed as dangerous, so scope the config to just this rule.
  console.log("removing newly-unused imports");
  writeSingleRuleConfig("no-unused-vars");
  runOxlintFix(["--fix-dangerously"]);
} finally {
  rmSync(derivedConfigPath, { force: true });
}
