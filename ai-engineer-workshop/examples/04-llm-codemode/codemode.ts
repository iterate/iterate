import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
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
const defaultTimeoutMs = 15_000;
const defaultMaxBufferBytes = 1_000_000;

type CodemodeState = {
  executedBlockCount: number;
};

export function createCodemodeProcessor({
  codemodeRootDirectory,
  timeoutMs = defaultTimeoutMs,
}: {
  codemodeRootDirectory: string;
  timeoutMs?: number;
}) {
  return defineProcessor<CodemodeState>(() => ({
    slug: "codemode",
    initialState: {
      executedBlockCount: 0,
    },

    reduce: ({ event, state }) => {
      if (event.type !== codemodeBlockAddedType) {
        return state;
      }

      return {
        executedBlockCount: state.executedBlockCount + 1,
      };
    },

    afterAppend: async ({ append, event, state }) => {
      if (event.type !== codemodeBlockAddedType) {
        return;
      }

      const block = CodemodeBlockAddedPayload.safeParse(event.payload);
      if (!block.success) {
        return;
      }

      void runCodemodeBlock({
        append,
        blockCount: state.executedBlockCount,
        blockId: block.data.blockId,
        code: block.data.code,
        codemodeRootDirectory,
        requestId: block.data.requestId,
        timeoutMs,
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
  timeoutMs,
}: {
  append: (event: EventInput) => unknown;
  blockCount: number;
  blockId: string;
  code: string;
  codemodeRootDirectory: string;
  requestId: string;
  timeoutMs: number;
}) {
  const startedAt = Date.now();
  const runDirectory = path.join(codemodeRootDirectory, String(blockCount));
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
      {
        maxBuffer: defaultMaxBufferBytes,
        timeout: timeoutMs,
      },
    );

    const runResult = await execFileAsync(process.execPath, [compiledPath], {
      maxBuffer: defaultMaxBufferBytes,
      timeout: timeoutMs,
    });

    await fs.writeFile(
      outputPath,
      formatOutputText({
        compileStderr: compileResult.stderr,
        compileStdout: compileResult.stdout,
        runStderr: runResult.stderr,
        runStdout: runResult.stdout,
      }),
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
        stderr: joinText([compileResult.stderr, runResult.stderr]),
        stdout: joinText([compileResult.stdout, runResult.stdout]),
        success: true,
      },
    });
  } catch (error) {
    const executionError =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : "Unknown codemode execution error");
    const stdout = getField(executionError, "stdout");
    const stderr = getField(executionError, "stderr") || executionError.message;

    await fs.writeFile(
      outputPath,
      formatOutputText({
        compileStderr: stderr,
        compileStdout: stdout,
        runStderr: "",
        runStdout: "",
      }),
      "utf8",
    );

    await append({
      type: codemodeResultAddedType,
      payload: {
        blockCount,
        blockId,
        codePath,
        durationMs: Date.now() - startedAt,
        exitCode: getExitCode(executionError),
        outputPath,
        requestId,
        stderr,
        stdout,
        success: false,
      },
    });
  }
}

function formatOutputText({
  compileStderr,
  compileStdout,
  runStderr,
  runStdout,
}: {
  compileStderr: string;
  compileStdout: string;
  runStderr: string;
  runStdout: string;
}) {
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

function getExitCode(error: Error) {
  const candidate = Reflect.get(error, "code");
  return typeof candidate === "number" ? candidate : 1;
}

function getField(error: Error, key: "stdout" | "stderr") {
  const candidate = Reflect.get(error, key);
  return typeof candidate === "string" ? candidate : "";
}

function joinText(parts: string[]) {
  return parts.filter((part) => part.length > 0).join("\n");
}
