import { vibeRulesFromFiles } from "./index.ts";

// The source of truth for all rules is now the markdown files in vibe-rules/rules/
// This file loads them using vibeRulesFromFiles() which reads markdown files with YAML frontmatter.
// Eventually, vibe-rules/ and estates/iterate/rules should converge - this is the first step.

const rules = vibeRulesFromFiles("./rules/**/*.md");

export default rules;
