# CLI Scripts

Prefer normal TypeScript files for repo scripts. The script should expose a
small command surface, keep business logic importable, and avoid hiding real
work inside YAML or shell strings.

## Existing Examples

- `scripts/preview/preview.ts` is run from the root `preview` script with
  `trpc-cli scripts/preview/preview.ts`.
- `apps/os/scripts/cli.ts` and `apps/semaphore/scripts/cli.ts` use
  `createCli({ ...import.meta, jsonInput: "auto" })` for richer app CLIs.
- `packages/iterate/pubme.js` is a compact oRPC router wired into `trpc-cli`.
- `scripts/ci/*.ts` are direct CI command modules. They are intentionally plain
  TypeScript because Depot YAML should call scripts, not embed large code
  strings.

## Recommended Shape

For small scripts, export functions and let `trpc-cli` expose them:

```bash
trpc-cli scripts/preview/preview.ts --help
```

For app-style CLIs, use the existing pattern:

```ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";

export async function doThing(options: { name: string }) {
  return { ok: true, name: options.name };
}

if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))) {
  void createCli({
    ...import.meta,
    name: "my-script",
    jsonInput: "auto",
  }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
```

For validated command routers, use oRPC plus Zod as in `packages/iterate/pubme.js`:

```ts
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod";

const router = {
  publish: os
    .input(
      z.object({
        version: z.string().describe("Version to publish"),
        dryRun: z.boolean().default(false).describe("Print without changing state"),
      }),
    )
    .handler(async ({ input }) => input),
};

createCli({ router }).run();
```

`trpc-cli` also supports TypeBox schemas. This repo currently standardizes on
Zod/oRPC in its examples; use TypeBox only when the script is already
JSON-schema-first or the surrounding package uses TypeBox.

## CI Scripts

Depot workflows should call scripts directly:

```yaml
- name: Update PR dashboard
  run: pnpm tsx scripts/ci/pr-dashboard.ts
```

Keep CI scripts deterministic:

- read secrets from environment variables or Doppler;
- fail loudly when required env vars are missing;
- keep Slack/GitHub helpers shared in `scripts/ci`;
- make the real function exportable so it can be imported by tests later;
- do not use interactive prompts in CI.

When a command needs human prompts locally, use `isAgent()` to disable prompts
for agents and CI.
