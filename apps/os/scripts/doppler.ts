import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

type LoadOsDopplerSecretsOptions = {
  /** Doppler config to load. Defaults to the local apps/os Doppler setup. */
  config?: string;
  /** Environment used for the Doppler CLI process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
};

export function loadOsDopplerSecrets(options: LoadOsDopplerSecretsOptions = {}) {
  try {
    const result = spawnSync(
      "doppler",
      [
        "secrets",
        "download",
        "--no-file",
        "--format",
        "json",
        ...(options.config ? ["--config", options.config] : []),
      ],
      {
        cwd: APP_ROOT,
        encoding: "utf8",
        env: options.env || process.env,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) {
      return {
        ok: false as const,
        error: result.stderr.trim() || `doppler exited with status ${result.status}`,
      };
    }

    return { ok: true as const, secrets: JSON.parse(result.stdout) as Record<string, string> };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}
