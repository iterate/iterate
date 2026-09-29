# @iterate-com/ai-linter

Lints a GitHub repository's pull requests against the repository's own rules folder: each head of
an open, non-draft pull request, against the rules at the pull request's base. Findings on added
lines become one COMMENT review from the GitHub connection's App (`iterate[bot]` for iterate's) with
inline comments, and every head gets the "Iterate GitHub AI linter" Check Run: success, or neutral
with findings or with a part that did not run. Never blocking. Userspace: a project installs this
package; the platform ships none of it. iterate/iterate's `rules/README.md` documents the rule
format.

A rule is decided by one of two engines. An `engine: llm` rule is read by the LLM
(`openai/gpt-6-astra` unless the install names another model), in one call over the diff, or, for a
rule with `select` and `window`, over only the units its selector picks on added lines with the
lines around each (a pull request with none makes no call). An `engine: jev` rule is decided by
`typesafe/jev`, one yes/no request per unit its selector picks on an added line; a unit Jev is
unsure of goes to the LLM in one more, small call. The Check Run says which engine decided each
finding. `iterate-lint-disable[-line|-next-line] rule -- reason` comments suppress a finding.

A part that fails (the LLM's call, Jev or one of its requests, a rule file, a file it reads or
GitHub lists without its name, the review) takes nothing else with it: what the rest found is
published, the Check Run lists what did not run at its top, and a head delivered again (readied,
reopened) is linted again. The LLM's answers are kept in the processor's storage until the head's
outcome is on the log, so a lint the platform restarts (a deploy) does not pay for them twice. Every
model call names the project, so the AI Gateway's per-project cap bounds what the linter spends.

## Install

The project needs a GitHub connection whose installation reaches the repository (Dash →
Integrations → Connect GitHub). It installs the linter from a folder of its config repo:

```text
ai-linter/package.json   { "main": "index.ts", "dependencies": { "@iterate-com/ai-linter": "https://pkg.pr.new/iterate/iterate/@iterate-com/ai-linter@<sha>" } }
ai-linter/index.ts       export { AiLinterDurableObject } from "@iterate-com/ai-linter";
```

and a session mounts that folder. It writes rows that lend the connection's log the root's egress
and model, which only a person's or the operator's session may write, never a config worker or an
`itx run`. From a clone of the config repo whose root `package.json` lists the package (so
`npm install` gets it):

```sh
iterate repl --project <slug>
itx> const { installAiLinter } = await import("@iterate-com/ai-linter/install")
itx> const source = await itx.repos.get("/repos/config").modules({ dir: "ai-linter" })
itx> await installAiLinter(itx, source, { repository: "acme/app" })
```

`installAiLinter(itx, source, { repository, rules, model, connection })`:

- `repository`: the GitHub repository whose pull requests it lints, `owner/name`.
- `rules`: its rules folder, `rules` by default.
- `model`: the LLM, `openai/gpt-6-astra` by default.
- `connection`: by default the project's one GitHub connection to the repository's owner.

It enables the `ai-linter` processor on `/integrations/github/<connection>` and appends
`ai-linter/installed` with those choices; the latest marker's hold, and what came before the first
is never linted. To upgrade, pin a newer build and install again.

| File                    | What                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `src/contract.ts`       | What the linter is: its queue's state and its facts                           |
| `src/processor.ts`      | `AiLinterProcessor`: the queue of heads, one lint at a time, the outcome      |
| `src/run.ts`            | One lint of one head, its I/O handed in; publishes what it has                |
| `src/lint.ts`           | The pure half: rules, globs, patches, suppressions, the prompt, the Check Run |
| `src/jev.ts`            | The Jev engine's pure half: selectors, requests, bands, excerpts              |
| `src/durable-object.ts` | `AiLinterDurableObject`, the class a project's folder re-exports              |
| `src/install.ts`        | `aiLinterFolder` and `installAiLinter`: the folder and its mount              |
| `src/fixtures/`         | The Jev lint experiment's labelled cases and the rules they were measured on  |
