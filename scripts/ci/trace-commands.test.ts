import { expect, test } from "vitest";
import { stepCommands } from "./trace-commands.ts";

test("uses authored commands, strips Doppler wrappers and walks parallel/sequential steps", () => {
  const commands = stepCommands(`
jobs:
  prepare:
    steps:
      - id: install_dependencies
        run: pnpm install --frozen-lockfile --prefer-offline
      - id: prepare
        run: >-
          doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN --
          pnpm preview ci-prepare $PREVIEW_TARGET_ARGS
  finish:
    steps:
      - parallel:
          - id: erase
            run: doppler run --project _shared --config prd -- pnpm preview erase
          - sequential:
              - id: merge_reports
                run: pnpm preview ci-finish
`);
  expect(Object.fromEntries(commands)).toEqual({
    "prepare/install_dependencies": "pnpm install --frozen-lockfile --prefer-offline",
    "prepare/prepare": "pnpm preview ci-prepare $PREVIEW_TARGET_ARGS",
    "finish/erase": "pnpm preview erase",
    "finish/merge_reports": "pnpm preview ci-finish",
  });
});
