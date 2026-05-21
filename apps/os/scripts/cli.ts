import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

/**
 * `pnpm cli` should mean "run the OS CLI for the current Doppler environment".
 *
 * If the caller is already inside `doppler run`, preserve that exact config:
 *
 *   doppler run --config prd -- pnpm cli rpc --help
 *   doppler run --config preview_3 -- pnpm cli rpc --help
 *
 * If not, enter Doppler without naming a project or config. Doppler then uses
 * the user's local `doppler setup` for `apps/os`, normally `dev_<user>`.
 */
if (!process.env.DOPPLER_CONFIG) {
  run("doppler", ["run", "--", "tsx", fileURLToPath(import.meta.url), ...args], process.env);
}

run("iterate-app-cli", args, process.env);

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv): never {
  const result = spawnSync(command, commandArgs, {
    env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}
