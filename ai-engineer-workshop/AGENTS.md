# AI Engineer Workshop

## Running scripts

- From `ai-engineer-workshop/`, run `pnpm w run` to open the interactive script picker.
- You can also run a script directly by passing path segments, e.g. `pnpm w run workshop 06-nano-agent-with-streaming-llm-processor`.
- To append a bundled dynamic-worker processor to a stream, use `pnpm w deploy processor --file ./workshop/agent-processor.ts --stream-path /your/path`.
- `deploy processor` can also append one optional seed event with `--event-json '{"type":"...","payload":{...}}'`.
- The CLI is built from exported oRPC procedures in this folder tree. It imports candidate `.ts` / `.js` files and turns them into subcommands.

## Entrypoint shape

- Entrypoint scripts should export `handler` (or `default`) as an oRPC procedure.
- Use `os.handler(...)` for scripts that only need the shared workshop input.
- Use `os.input(z.object({...})).handler(...)` for scripts that add script-specific input on top of the shared workshop input.
- Shared workshop input always includes `pathPrefix` and `logLevel`.
- Call `runIfMain(import.meta.url, handler)` at the bottom so the file can also be run directly.
