import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { promisify } from "node:util";
import { defineProcessor } from "ai-engineer-workshop";
import {
  codemodeBlockAddedType,
  codemodeResultAddedType,
  codemodeToolAddedType,
  readCodemodeBlock,
  readCodemodeTool,
} from "./codemode-types.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const typescriptCliPath = require.resolve("typescript/bin/tsc");

type ToolDefinition = { toolName: string; code: string };
type CodemodeState = {
  blockIndex: number;
  currentBlock: null | { blockId: string; code: string; blockIndex: number };
  tools: ToolDefinition[];
};

export function createCodemodeProcessor({
  codemodeRootDirectory,
  streamPath,
}: {
  codemodeRootDirectory: string;
  streamPath: string;
}) {
  return defineProcessor<CodemodeState>(() => ({
    slug: "codemode",
    initialState: { blockIndex: 0, currentBlock: null, tools: [] },

    reduce: ({ event, state }) => {
      if (event.type === codemodeBlockAddedType) {
        const block = readCodemodeBlock(event.payload);
        if (block == null) {
          return state;
        }

        return {
          ...state,
          blockIndex: state.blockIndex + 1,
          currentBlock: { ...block, blockIndex: state.blockIndex + 1 },
        };
      }

      if (event.type === codemodeToolAddedType) {
        const tool = readCodemodeTool(event.payload);
        if (tool == null) {
          return state;
        }

        return {
          ...state,
          tools: [...state.tools.filter((entry) => entry.toolName !== tool.toolName), tool],
        };
      }

      return state;
    },

    async afterAppend({ append, event, state }) {
      if (event.type !== codemodeBlockAddedType && event.type !== codemodeToolAddedType) {
        return;
      }

      if (state.currentBlock == null) {
        return;
      }

      const runDirectory = path.join(
        codemodeRootDirectory,
        ...streamPath.split("/").filter(Boolean),
        String(state.currentBlock.blockIndex),
      );
      const mainPath = path.join(runDirectory, "main.ts");
      const outputPath = path.join(runDirectory, "out.txt");
      const toolsDirectory = path.join(runDirectory, "tools");
      const runnerPath = path.join(runDirectory, "runner.ts");
      const compiledDirectory = path.join(runDirectory, "compiled");
      const compiledRunnerPath = path.join(compiledDirectory, "runner.js");

      await fs.mkdir(toolsDirectory, { recursive: true });
      await fs.writeFile(mainPath, `${state.currentBlock.code}\n`, "utf8");

      const imports = state.tools
        .map(
          (tool, index) =>
            `import addTool${index} from "./tools/${toToolFileName(tool.toolName)}.js";`,
        )
        .join("\n");
      const applyTools = state.tools.map((_, index) => `  await addTool${index}(ctx);`).join("\n");

      for (const tool of state.tools) {
        await fs.writeFile(
          path.join(toolsDirectory, `${toToolFileName(tool.toolName)}.ts`),
          `${tool.code}\n`,
          "utf8",
        );
      }

      await fs.writeFile(
        runnerPath,
        [
          imports,
          'import run from "./main.js";',
          "",
          "const ctx = { streamPath: " + JSON.stringify(streamPath) + " };",
          applyTools,
          'if (typeof run !== "function") {',
          '  throw new Error("codemode block must export default async function(ctx)");',
          "}",
          "const value = await run(ctx);",
          "console.log(JSON.stringify(value ?? null));",
        ]
          .filter(Boolean)
          .join("\n"),
        "utf8",
      );

      try {
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
            runnerPath,
          ],
          { timeout: 15_000 },
        );

        const run = await execFileAsync(process.execPath, [compiledRunnerPath], {
          maxBuffer: 1_000_000,
          timeout: 15_000,
        });
        const output = [run.stdout, run.stderr].filter(Boolean).join("\n");

        await fs.writeFile(outputPath, output, "utf8");
        await append({
          event: {
            type: codemodeResultAddedType,
            payload: {
              blockId: state.currentBlock.blockId,
              codePath: mainPath,
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
              blockId: state.currentBlock.blockId,
              codePath: mainPath,
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

function toToolFileName(toolName: string) {
  return toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
