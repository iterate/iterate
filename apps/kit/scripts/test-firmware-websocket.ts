import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const projectDirectory = resolve(
  appDirectory,
  "firmware/tests/esp_idf_tcp_transport_host",
);
const incidentTests = [
  "upgrade spillover is visible without later socket traffic",
  "zero payload progress retains the current frame",
];
const oneFailedTestSummary =
  /test cases:\s+1\s+\|\s+0 passed\s+\|\s+1 failed/;

export function firmwareWebsocketBuildDirectories(options: {
  proveStockFails?: boolean;
}) {
  /*
   * The patched proof and its stock red control are independent CI lanes and
   * are routinely useful in parallel. Sharing CMake's mutable build directory
   * made concurrent invocations corrupt generated component metadata; that
   * looked like an ESP-IDF compatibility failure even though neither source
   * tree was wrong. Give the control invocation its own patched-baseline
   * directory as well as its stock directory. A lock or forced serialization
   * was rejected because it hides accidental coupling and needlessly lengthens
   * the proof.
   */
  return {
    patchedBuildDirectory: resolve(
      appDirectory,
      options.proveStockFails
        ? ".build/esp-idf-tcp-transport-control-baseline"
        : ".build/esp-idf-tcp-transport-host",
    ),
    stockBuildDirectory: resolve(
      appDirectory,
      ".build/esp-idf-tcp-transport-stock-control",
    ),
  };
}

function runOrThrow(
  executable: string,
  args: readonly string[],
  options: { capture?: boolean } = {},
) {
  const result = spawnSync(executable, args, {
    cwd: appDirectory,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(
      `${executable} ${args.join(" ")} was terminated by ${result.signal}.`,
    );
  }
  if (result.status !== 0) {
    const output = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(
      `${executable} ${args.join(" ")} exited with ${result.status}.${output}`,
    );
  }
  return result;
}

export function testFirmwareWebsocket(options: {
  proveStockFails?: boolean;
  environment?: Readonly<NodeJS.ProcessEnv>;
} = {}) {
  const environment = options.environment ?? process.env;
  const idfPath = environment.IDF_PATH;
  const pythonEnvironmentPath = environment.IDF_PYTHON_ENV_PATH;
  if (!idfPath || !pythonEnvironmentPath) {
    throw new Error(
      "ESP-IDF is not active. Source its export.sh before running firmware:test:websocket.",
    );
  }

  const python = join(pythonEnvironmentPath, "bin/python");
  const idfPy = join(idfPath, "tools/idf.py");
  if (!existsSync(python) || !existsSync(idfPy)) {
    throw new Error(
      `ESP-IDF environment is incomplete: expected ${python} and ${idfPy}.`,
    );
  }

  const { patchedBuildDirectory, stockBuildDirectory } =
    firmwareWebsocketBuildDirectories(options);
  runOrThrow(python, [
    idfPy,
    "-C",
    projectDirectory,
    "-B",
    patchedBuildDirectory,
    "reconfigure",
    "build",
  ]);
  runOrThrow(
    join(patchedBuildDirectory, "iterate_kit_tcp_transport_host_test.elf"),
    ["--reporter", "compact"],
  );

  if (!options.proveStockFails) return;

  /*
   * A compatibility test is weak if it also passes after its patch is removed.
   * Build the exact same project against stock ESP-IDF, then run each incident
   * independently. Catch2 returns the number of failed test cases, capped at
   * 255, so one deliberately selected failing case must return 1. Requiring
   * both that status and the reporter's one-failure summary avoids
   * misclassifying a crash, setup error, missing executable, or accidentally
   * broad filter as the expected red control.
   */
  runOrThrow(python, [
    idfPy,
    "-C",
    projectDirectory,
    "-B",
    stockBuildDirectory,
    "-DITERATE_KIT_TEST_STOCK_TCP_TRANSPORT=ON",
    "reconfigure",
    "build",
  ]);
  const stockExecutable = join(
    stockBuildDirectory,
    "iterate_kit_tcp_transport_host_test.elf",
  );
  for (const testName of incidentTests) {
    const result = spawnSync(
      stockExecutable,
      [testName, "--reporter", "compact"],
      {
        cwd: appDirectory,
        encoding: "utf8",
      },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (
      result.signal ||
      result.status !== 1 ||
      !oneFailedTestSummary.test(output)
    ) {
      throw new Error(
        `Stock ESP-IDF did not produce the expected assertion failure for ${JSON.stringify(testName)}.\n${output}`,
      );
    }
    console.log(`Expected stock-IDF failure proved: ${testName}`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(process.argv[1], "file:"))
) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--prove-stock-fails");
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown.join(", ")}`);
    process.exitCode = 1;
  } else {
    try {
      testFirmwareWebsocket({
        proveStockFails: args.includes("--prove-stock-fails"),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
