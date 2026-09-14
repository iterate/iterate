# Agent instructions and skills

`AGENTS.md` is the canonical regular instruction file in each scope. `CLAUDE.md` and other compatibility entrypoints symlink to it. Human READMEs may link to instructions, but do not load an entire README automatically through an AGENTS symlink.

Keep automatic context to local constraints, commands and a few links. Longer architecture explanations, runbooks and examples belong in ordinary docs and are read when relevant. Prefer facts the model cannot infer from code or command help; remove generic engineering tutorials, repeated rules and obsolete workarounds.

Skills live in `.agents/skills/` and must provide a distinct local capability. Keep descriptions short and precise, with conditional detail in directly linked references. A skill does not authorize commits, publishing, deployments or external actions beyond the user's request. Avoid mandatory interviews or extra confirmation when the task is already clear and authorized.

Codex and OpenCode discover `.agents/skills/` directly; `.claude/skills` and `.cursor/skills` symlink to that tree. No sync command or skill installer dependency is needed. Personal skills belong in the user's personal tree. Do not restore removed skills through aliases or copy instructions into each client directory.

When retiring an entry, check inbound links, tool symlinks, current source references and useful non-obvious constraints. Keep operational safety and acceptance requirements in their canonical docs. New instructions should address a demonstrated gap; first correct or remove conflicting guidance.

`configs/*/AGENTS.md` and the project config-repo template are product prompt assets, not developer onboarding docs. Changes there require their own product behavior evaluation.
