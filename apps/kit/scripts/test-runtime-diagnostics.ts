import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDirectory = resolve(packageDirectory, "firmware");
const buildDirectory = resolve(
  packageDirectory,
  "firmware/build-runtime-diagnostics",
);
const fixturePath = resolve(
  buildDirectory,
  "iterate-kit-runtime-diagnostics-fixture",
);

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: packageDirectory,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            `${command} ${args.join(" ")} failed: code=${String(code)} signal=${String(signal)}`,
          ),
        );
      }
    });
  });
}

/*
 * The wire proof deliberately crosses language/tool boundaries: CTest owns
 * allocation/budget behavior and Vitest owns the exact parser used by the
 * physical recorder. Building the fixture here prevents a stale developer
 * binary from making the TypeScript half green after the C schema changes.
 */
await run("cmake", [
  "-S",
  sourceDirectory,
  "-B",
  buildDirectory,
  "-DCMAKE_BUILD_TYPE=MinSizeRel",
]);
await run("cmake", [
  "--build",
  buildDirectory,
  "--target",
  "iterate-kit-runtime-diagnostics-test",
  "iterate-kit-runtime-diagnostics-fixture",
  "--parallel",
]);
await run("ctest", [
  "--test-dir",
  buildDirectory,
  "--output-on-failure",
  "-R",
  "^iterate-kit-runtime-diagnostics-test$",
]);
await run(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "firmware/__tests__/vitest.config.ts",
  ],
  {
    ...process.env,
    ITERATE_KIT_RUNTIME_DIAGNOSTICS_FIXTURE: fixturePath,
  },
);
