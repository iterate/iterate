import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { previewInternals } from "./preview.ts";

test.each(["reset", "down"] as const)(
  "%s erases OS and Streams state; only a normal reset preserves artifacts",
  async (operation) => {
    await using commands = await captureDopplerCommands();
    const erase = previewInternals.makePreviewSlotDataEraser(
      {
        commandEnvironment: commands.environment,
        repositoryRoot: resolve(import.meta.dirname, "../.."),
      },
      operation,
    );

    await erase({ dopplerConfig: "preview_3", slug: "preview-3" });

    expect(await commands.read()).toEqual([
      [
        "run",
        "--project",
        "os",
        "--config",
        "preview_3",
        "--",
        "pnpm",
        "run-script",
        "destroy",
        "--env",
        "preview_3",
        ...(operation === "reset" ? ["--preserve-artifacts"] : []),
      ],
      [
        "run",
        "--project",
        "streams-example-app",
        "--config",
        "preview_3",
        "--",
        "pnpm",
        "run-script",
        "destroy",
        "--env",
        "preview_3",
      ],
    ]);
  },
);

async function captureDopplerCommands() {
  const directory = await mkdtemp(join(tmpdir(), "preview-cleanup-"));
  const receipt = join(directory, "commands.jsonl");
  await writeFile(
    join(directory, "doppler"),
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.COMMAND_RECEIPT, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    { mode: 0o755 },
  );
  return {
    environment: { PATH: `${directory}${delimiter}${process.env.PATH}`, COMMAND_RECEIPT: receipt },
    read: async () =>
      (await readFile(receipt, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    [Symbol.asyncDispose]: async () => await rm(directory, { recursive: true, force: true }),
  };
}
