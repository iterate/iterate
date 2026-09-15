import { z } from "zod/v4";
import { doppler } from "../apps/os/scripts/dev.ts";
import { OsPlaywrightAuthEnv } from "./test-support/auth-config.ts";

/** Runs once before test workers; their environments inherit the prepared values. */
export default function setup() {
  const startedAt = Date.now();
  let env = OsPlaywrightAuthEnv.safeParse(process.env);
  if (!env.success) {
    const dopplerEnv = doppler.loadOsSecrets();
    if (!dopplerEnv.ok) {
      throw new Error(
        [
          "Playwright auth setup failed. Run with `doppler run --project os --config <dev|preview_N> -- pnpm spec`, or configure Doppler for apps/os.",
          z.prettifyError(env.error),
          dopplerEnv.error,
        ].join("\n\n"),
      );
    }
    env = OsPlaywrightAuthEnv.safeParse({ ...dopplerEnv.secrets, ...process.env });
    if (!env.success) {
      throw new Error(
        "Playwright auth setup failed: environment and apps/os Doppler config do not supply valid auth settings.\n" +
          z.prettifyError(env.error),
      );
    }
  }
  Object.assign(process.env, env.data);
  console.log(`[playwright] auth setup complete (${Date.now() - startedAt}ms)`);
}
