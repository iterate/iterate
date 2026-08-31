// e2e/support/solo-config.ts — THE one place the SOLO test topology is built: read wrangler.jsonc
// and patch it so the real project-worker runs standalone under createTestHarness (local workerd,
// production build hook, no external control-plane worker). Shared by the e2e lane's global-setup
// (one worker per run) and the harness lane's per-file boot (__tests__/harness.ts).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root (this file lives at e2e/support/). */
export const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** jsonc → object without a parser dependency: strip comments + trailing commas (our config keeps
 *  strings comment-free, so the naive strip is safe HERE — not a general jsonc parser). */
function readWranglerConfig(): Record<string, unknown> {
  const raw = readFileSync(join(PACKAGE_DIR, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

/** wrangler.jsonc patched for the SOLO topology: absolute main/build paths, local-only migrations
 *  (fresh storage can't replay prod's rename-chain history — only the LIVE class matters), and
 *  FALLBACK rebound to this worker's own DummyControlPlane entrypoint (egress + itx.os bottom out
 *  there — the topology wrangler.jsonc's own comment describes). */
export function soloWorkerConfig(): Record<string, unknown> {
  const config = readWranglerConfig();
  config.main = join(PACKAGE_DIR, String(config.main));
  config.build = { ...(config.build as object), cwd: PACKAGE_DIR };
  config.migrations = [{ tag: "local", new_sqlite_classes: ["StreamDurableObject"] }];
  config.services = [
    { binding: "FALLBACK", service: String(config.name), entrypoint: "DummyControlPlane" },
  ];
  return config;
}
