// e2e/support/solo-config.ts — THE one place the SOLO test topology is built: read wrangler.jsonc
// (wrangler's own reader, so the config is what wrangler sees) and patch it so the real
// project-worker runs standalone under createTestHarness (local workerd, production build hook, no
// external control-plane worker). Shared by the e2e lane's global-setup (the one worker every file
// speaks to) and support/log-harness.ts (the second worker the console-reading file boots).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";

/** The package root (this file lives at e2e/support/). */
export const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** wrangler.jsonc patched for the SOLO topology: absolute main/build paths, and FALLBACK rebound to
 *  this worker's own DummyControlPlane entrypoint (egress bottoms out there — the topology
 *  wrangler.jsonc's own comment describes). The DO lifecycle is declarative (`exports`), so there is
 *  no migration history a fresh local namespace would have to replay. */
export function soloWorkerConfig(): Unstable_RawConfig {
  const { rawConfig } = experimental_readRawConfig({ config: join(PACKAGE_DIR, "wrangler.jsonc") });
  return {
    ...rawConfig,
    main: join(PACKAGE_DIR, String(rawConfig.main)),
    build: { ...rawConfig.build, cwd: PACKAGE_DIR },
    services: [
      { binding: "FALLBACK", service: String(rawConfig.name), entrypoint: "DummyControlPlane" },
    ],
  };
}
