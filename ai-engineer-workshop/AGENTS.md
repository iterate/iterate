# AI Engineer Workshop

## Running scripts

- From `ai-engineer-workshop/`, run `pnpm w run` to open the interactive script picker.
- You can also run a script directly by passing path segments, e.g. `pnpm w run workshop 06-nano-agent-with-streaming-llm-processor`.
- The CLI is built from exported oRPC procedures in this folder tree. It imports candidate `.ts` / `.js` files and turns them into subcommands.

## Entrypoint shape

- Entrypoint scripts should export `handler` (or `default`) as an oRPC procedure.
- Use `os.handler(...)` for scripts that only need the shared workshop input.
- Use `os.input(z.object({...})).handler(...)` for scripts that add script-specific input on top of the shared workshop input.
- Shared workshop input always includes `pathPrefix` and `logLevel`.
- Call `runIfMain(import.meta.url, handler)` at the bottom so the file can also be run directly.

## Discovery rules

- Candidate files are searched recursively from `ai-engineer-workshop/`.
- `dist`, `node_modules`, `web`, `e2e`, and `lib` are skipped.
- `*.test.ts`, `*.e2e.test.ts`, `*.d.ts`, and `*-types.ts` are skipped.
- Files named `cli.ts`, `sdk.ts`, `contract.ts`, `test-helpers.ts`, `agent.ts`, `codemode.ts`, `prompt.ts`, and `slack-input.ts` are skipped.
- A file only becomes a runnable command if `mod.handler ?? mod.default` exists and has `~orpc`.

## Important caveat

- The CLI imports candidate modules during discovery, before you select a command.
- Keep entrypoint modules free of top-level side effects. Avoid top-level network calls, logging, proof code, or anything that should only run after the command is selected.
- Put one-off proof scripts behind their own explicit runner or keep them out of the discovered entrypoint set unless you want them to show up in `pnpm w run`.
