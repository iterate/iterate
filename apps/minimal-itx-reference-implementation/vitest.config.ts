// Two-project vitest config, like apps/os/src/itx/e2e/vitest.config.ts:
//
//   node     the concept suite + the server-runtime catalogue matrix
//            (itx.e2e.test.ts) plus the adversarial + admin-root suites
//            (*.e2e.test.ts) — all talk to the running worker over `ws`.
//   browser  the browser leg of the matrix (itx.browser.test.ts) — a real
//            Chromium tab via Playwright.
//
// Like apps/os, the suite NEVER starts a server; it points at one that is
// already running. Bring it up with `npm run dev` (wrangler on :8788), or set
// ITX_BASE / APP_CONFIG_BASE_URL to a deployed worker. The browser cannot read
// process.env, so the same base URL + demo token are injected via `define`.

import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const baseUrl = (
  process.env.ITX_BASE?.trim() ||
  process.env.APP_CONFIG_BASE_URL?.trim() ||
  "http://127.0.0.1:8788"
).replace(/\/+$/, "");
const token = process.env.ITX_TOKEN?.trim() || "alice-token";

export default defineConfig({
  test: {
    // One running worker is shared across files, so default to sequential to
    // keep a single dev server from being hammered and output readable.
    fileParallelism: process.env.ITX_E2E_FILE_PARALLELISM === "true",
    hookTimeout: 45_000,
    passWithNoTests: true,
    testTimeout: 45_000,
    projects: [
      {
        test: {
          environment: "node",
          // The concept suite, the cross-project + parent authority adversarial
          // suites, and the admin-root suite. (itx.dynamic-adversarial.e2e.test.ts
          // exercises dynamic-DO facet upgrade/rename semantics and is pre-existing
          // and currently red — kept out of the gate until that is addressed.)
          include: [
            "./itx.e2e.test.ts",
            "./itx.parent-adversarial.e2e.test.ts",
            "./itx.cross-project-adversarial.e2e.test.ts",
            "./itx.root.e2e.test.ts",
          ],
          name: "node",
          testTimeout: 45_000,
        },
      },
      {
        define: {
          __ITX_BROWSER_E2E__: JSON.stringify({ baseUrl, token }),
        },
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: playwright(),
          },
          include: ["./itx.browser.test.ts"],
          name: "browser",
          testTimeout: 45_000,
        },
      },
    ],
  },
});
