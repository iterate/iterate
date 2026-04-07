import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { promisify } from "node:util";
import { defineProcessor } from "ai-engineer-workshop";
import {
  codemodeBlockAddedType,
  codemodeResultAddedType,
  readCodemodeBlock,
} from "./codemode-types.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptCliPath = require.resolve("typescript/bin/tsc");

export function createCodemodeProcessor({
  codemodeRootDirectory,
  streamPath,
}: {
  codemodeRootDirectory: string;
  streamPath: string;
}) {
  return defineProcessor<number>(() => ({
    slug: "codemode",
    initialState: 0,

    reduce: ({ event, state }) => (event.type === codemodeBlockAddedType ? state + 1 : state),

    async afterAppend({ append, event, state }) {
      if (event.type !== codemodeBlockAddedType) {
        return;
      }

      const block = readCodemodeBlock(event.payload);
      if (block == null) {
        return;
      }

      const runDirectory = path.join(
        codemodeRootDirectory,
        ...streamPath.split("/").filter(Boolean),
        String(state),
      );
      const codePath = path.join(runDirectory, "code.ts");
      const outputPath = path.join(runDirectory, "out.txt");
      const compiledDirectory = path.join(runDirectory, "compiled");
      const compiledPath = path.join(compiledDirectory, "code.js");

      await fs.mkdir(runDirectory, { recursive: true });
      await fs.writeFile(codePath, `${block.code}\n`, "utf8");

      try {
        // Compile first so the workshop audience sees real TS errors instead of tsx magic.
        await execFileAsync(
          process.execPath,
          [
            typescriptCliPath,
            "--pretty",
            "false",
            "--target",
            "ES2024",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--types",
            "node",
            "--skipLibCheck",
            "--outDir",
            compiledDirectory,
            codePath,
          ],
          { timeout: 15_000 },
        );

        const run = await execFileAsync(process.execPath, [compiledPath], {
          maxBuffer: 1_000_000,
          timeout: 15_000,
        });
        const output = [run.stdout, run.stderr].filter(Boolean).join("\n");

        await fs.writeFile(outputPath, output, "utf8");
        await append({
          event: {
            type: codemodeResultAddedType,
            payload: {
              blockId: block.blockId,
              codePath,
              ok: true,
              output,
              outputPath,
              prompt: [
                "Your last code block finished successfully.",
                "",
                "```json",
                JSON.stringify({ ok: true, output }, null, 2),
                "```",
                "",
                "Only emit another ```ts``` block if more work is needed.",
              ].join("\n"),
            },
          },
        });
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        await fs.writeFile(outputPath, output, "utf8");
        await append({
          event: {
            type: codemodeResultAddedType,
            payload: {
              blockId: block.blockId,
              codePath,
              ok: false,
              output,
              outputPath,
              prompt: [
                "Your last code block failed.",
                "",
                "```json",
                JSON.stringify({ ok: false, output }, null, 2),
                "```",
                "",
                "Fix the code and emit a new ```ts``` block.",
              ].join("\n"),
            },
          },
        });
      }
    },
  }));
}
