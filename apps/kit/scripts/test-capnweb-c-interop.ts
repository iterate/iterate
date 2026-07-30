import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "firmware/vendor/capnweb");
const buildDirectory = resolve(packageDirectory, "firmware/build-capnweb-interop");
const nativePeerPath = resolve(buildDirectory, "capnweb-native-peer");

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
 * Build the C peer independently of the ESP target so this gate remains a
 * quick host compatibility test. Sanitizers cover the parser/session boundary
 * while Vitest supplies the actual @iterate-com/capnweb peer; neither half can
 * be replaced by a same-language mock without weakening the proof.
 */
await run("cmake", [
  "-S",
  sourceDirectory,
  "-B",
  buildDirectory,
  "-DCMAKE_BUILD_TYPE=RelWithDebInfo",
  "-DCAPNWEB_SANITIZE=ON",
]);
await run("cmake", ["--build", buildDirectory, "--parallel"]);
await run("ctest", ["--test-dir", buildDirectory, "--output-on-failure"]);
await run(
  "pnpm",
  ["exec", "vitest", "run", "--config", "firmware/vendor/__tests__/vitest.config.ts"],
  {
    ...process.env,
    ITERATE_KIT_CAPNWEB_NATIVE_PEER: nativePeerPath,
  },
);
