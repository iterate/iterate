/**
 * Provider Base Image Smoke Tests
 *
 * Purpose: validate provider API surface (create/exec/preview/fetch) using
 * a neutral base image/snapshot so failures point at the provider, not the
 * full Iterate sandbox image.
 */

import { describe, expect as vitestExpect } from "vitest";
import {
  RUN_SANDBOX_TESTS,
  TEST_BASE_SNAPSHOT_ID,
  TEST_CONFIG,
  createTestProvider,
  test,
} from "./helpers.ts";

const PREVIEW_BODY = "preview-ok";
const TEST_RUN_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EXTERNAL_ID = `test-base-image-test-${TEST_RUN_SUFFIX}`;
const TEST_ID = `base-image-test-${TEST_RUN_SUFFIX}`;
const PROVIDER_API_TEST_TIMEOUT_MS = TEST_CONFIG.provider === "fly" ? 180_000 : 120_000;

/**
 * Cleanup proof: deliberately create a Fly machine, skip cleanup, and fail.
 * The workflow's `if: always()` cleanup step must catch this leaked machine.
 * DELETE THIS BLOCK after verification.
 */
describe.runIf(RUN_SANDBOX_TESTS && TEST_CONFIG.provider === "fly")(
  "Cleanup proof (deliberate leak)",
  () => {
    const LEAK_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const LEAKED_EXTERNAL_ID = `test-base-image-test-leaked-${LEAK_SUFFIX}`;

    test.concurrent(
      "creates a machine, leaks it, and fails",
      async () => {
        const provider = createTestProvider();
        const sandbox = await provider.create({
          externalId: LEAKED_EXTERNAL_ID,
          id: `cleanup-proof-${LEAK_SUFFIX}`,
          name: "Cleanup Proof (delete me)",
          envVars: {},
          providerSnapshotId: TEST_BASE_SNAPSHOT_ID,
          entrypointArguments: ["sleep", "infinity"],
        });

        console.log(`[cleanup-proof] LEAKED machine created:`);
        console.log(`[cleanup-proof]   externalId = ${LEAKED_EXTERNAL_ID}`);
        console.log(`[cleanup-proof]   providerId = ${sandbox.providerId}`);
        console.log(`[cleanup-proof] Deliberately NOT deleting this sandbox.`);
        console.log(`[cleanup-proof] The if:always() cleanup step must catch it.`);

        // Deliberately fail — the machine is now leaked
        vitestExpect(true, "DELIBERATE FAILURE to test cleanup").toBe(false);
      },
      PROVIDER_API_TEST_TIMEOUT_MS,
    );
  },
);

describe
  .runIf(RUN_SANDBOX_TESTS)
  .concurrent(`Provider Base Image (${TEST_CONFIG.provider})`, () => {
    test.scoped({
      envOverrides:
        TEST_CONFIG.provider === "daytona"
          ? { DAYTONA_DEFAULT_SNAPSHOT: TEST_BASE_SNAPSHOT_ID }
          : {},
      sandboxOptions: {
        externalId: TEST_EXTERNAL_ID,
        id: TEST_ID,
        name: "Base Image Test",
        envVars: {},
        providerSnapshotId: TEST_BASE_SNAPSHOT_ID,
        entrypointArguments: ["sleep", "infinity"],
      },
    });

    test.concurrent(
      "provider api surface works",
      async ({ sandbox, expect }) => {
        const state = await sandbox.getState();
        expect(state.state).not.toBe("error");

        const echo = await sandbox.exec(["sh", "-c", "echo provider-ok"]);
        expect(echo).toContain("provider-ok");

        const pidnapRunning = await sandbox.exec([
          "sh",
          "-c",
          "ps -ef | grep -v grep | grep -q 'pidnap/src/cli.ts' && echo yes || echo no",
        ]);
        expect(pidnapRunning.trim()).toBe("no");

        const previewPort = TEST_CONFIG.provider === "docker" ? 3000 : 7777;

        await sandbox.exec(["sh", "-c", `echo "${PREVIEW_BODY}" > /tmp/preview-ok.txt`]);
        await sandbox.exec([
          "sh",
          "-c",
          [
            "if command -v python3 >/dev/null 2>&1; then",
            `python3 -m http.server ${previewPort} --bind 0.0.0.0 --directory /tmp >/tmp/preview-server.log 2>&1 &`,
            "elif command -v python >/dev/null 2>&1; then",
            `python -m http.server ${previewPort} --bind 0.0.0.0 --directory /tmp >/tmp/preview-server.log 2>&1 &`,
            "elif command -v busybox >/dev/null 2>&1; then",
            `busybox httpd -p ${previewPort} -h /tmp >/tmp/preview-server.log 2>&1 &`,
            "else",
            "echo 'no-http-server' > /tmp/preview-server.log; exit 1;",
            "fi",
          ].join(" "),
        ]);

        const baseUrl = await sandbox.getBaseUrl({ port: previewPort });
        // Fly sandboxes can be IPv6-only in some environments, making external fetch
        // from the local test runner unreliable even when the machine is healthy.
        if (TEST_CONFIG.provider === "fly") {
          await expect
            .poll(
              async () => {
                const internalFetch = await sandbox.exec([
                  "sh",
                  "-c",
                  `curl -sS --max-time 10 http://127.0.0.1:${previewPort}/preview-ok.txt`,
                ]);
                return internalFetch;
              },
              { timeout: 20_000, interval: 500 },
            )
            .toContain(PREVIEW_BODY);
          expect(baseUrl).toContain(".fly.dev");
          return;
        }

        await expect
          .poll(
            async () => {
              const response = await fetch(`${baseUrl}/preview-ok.txt`).catch(() => null);
              if (!response?.ok) return "";
              return await response.text();
            },
            { timeout: 20_000, interval: 500 },
          )
          .toContain(PREVIEW_BODY);
      },
      PROVIDER_API_TEST_TIMEOUT_MS,
    );
  });
