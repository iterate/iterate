import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { promisify } from "node:util";
import { defineProcessor, type EventInput } from "ai-engineer-workshop";
import {
  CodemodeBlockAddedPayload,
  codemodeBlockAddedType,
  codemodeResultAddedType,
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

    afterAppend: async ({ append, event, state }) => {
      if (event.type !== codemodeBlockAddedType) {
        return;
      }

      const parsed = CodemodeBlockAddedPayload.safeParse(event.payload);
      if (!parsed.success) {
        return;
      }

      void runCodemodeBlock({
        append,
        blockCount: state,
        blockId: parsed.data.blockId,
        code: parsed.data.code,
        codemodeRootDirectory,
        requestId: parsed.data.requestId,
        streamPath,
      });
    },
  }));
}

async function runCodemodeBlock({
  append,
  blockCount,
  blockId,
  code,
  codemodeRootDirectory,
  requestId,
  streamPath,
}: {
  append: (event: EventInput) => unknown;
  blockCount: number;
  blockId: string;
  code: string;
  codemodeRootDirectory: string;
  requestId: string;
  streamPath: string;
}) {
  const startedAt = Date.now();
  const runDirectory = path.join(
    codemodeRootDirectory,
    ...streamPath.split("/").filter(Boolean),
    String(blockCount),
  );
  const codePath = path.join(runDirectory, "code.ts");
  const compiledDirectory = path.join(runDirectory, "compiled");
  const compiledPath = path.join(compiledDirectory, "code.js");
  const outputPath = path.join(runDirectory, "out.txt");

  await fs.mkdir(runDirectory, { recursive: true });
  await fs.writeFile(codePath, `${code}\n`, "utf8");

  try {
    const compileResult = await execFileAsync(
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
      { maxBuffer: 1_000_000, timeout: 15_000 },
    );
    const runResult = await execFileAsync(process.execPath, [compiledPath], {
      maxBuffer: 1_000_000,
      timeout: 15_000,
    });
    const stdout = [compileResult.stdout, runResult.stdout].filter(Boolean).join("\n");
    const stderr = [compileResult.stderr, runResult.stderr].filter(Boolean).join("\n");

    await fs.writeFile(
      outputPath,
      renderOutputFile(
        compileResult.stdout,
        compileResult.stderr,
        runResult.stdout,
        runResult.stderr,
      ),
      "utf8",
    );
    await append({
      type: codemodeResultAddedType,
      payload: {
        blockCount,
        blockId,
        codePath,
        durationMs: Date.now() - startedAt,
        exitCode: 0,
        outputPath,
        requestId,
        stderr,
        stdout,
        success: true,
      },
    });
  } catch (error) {
    const executionError =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : "Unknown codemode execution error");
    const stdout = readExecField(executionError, "stdout");
    const stderr = readExecField(executionError, "stderr") || executionError.message;

    await fs.writeFile(outputPath, renderOutputFile(stdout, stderr, "", ""), "utf8");
    await append({
      type: codemodeResultAddedType,
      payload: {
        blockCount,
        blockId,
        codePath,
        durationMs: Date.now() - startedAt,
        exitCode:
          typeof Reflect.get(executionError, "code") === "number"
            ? (Reflect.get(executionError, "code") as number)
            : 1,
        outputPath,
        requestId,
        stderr,
        stdout,
        success: false,
      },
    });
  }
}

function renderOutputFile(
  compileStdout: string,
  compileStderr: string,
  runStdout: string,
  runStderr: string,
) {
  return [
    "compile stdout:",
    compileStdout,
    "",
    "compile stderr:",
    compileStderr,
    "",
    "run stdout:",
    runStdout,
    "",
    "run stderr:",
    runStderr,
  ].join("\n");
}

function readExecField(error: Error, key: "stdout" | "stderr") {
  const value = Reflect.get(error, key);
  return typeof value === "string" ? value : "";
}
