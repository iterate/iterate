/**
 * Provider Base Image Smoke Tests
 *
 * Purpose: validate provider API surface (create/exec/preview/fetch) using
 * a neutral base image/snapshot so failures point at the provider, not the
 * full Iterate sandbox image.
 */

import { describe } from "vitest";
import { RUN_SANDBOX_TESTS, TEST_BASE_SNAPSHOT_ID, TEST_CONFIG, test } from "./helpers.ts";

const PREVIEW_BODY = "preview-ok";

describe
  .runIf(RUN_SANDBOX_TESTS)
  .concurrent(`Provider Base Image (${TEST_CONFIG.provider})`, () => {
    test.scoped({
      envOverrides:
        TEST_CONFIG.provider === "daytona" ? { DAYTONA_SNAPSHOT_NAME: TEST_BASE_SNAPSHOT_ID } : {},
      sandboxOptions: {
        id: "base-image-test",
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

        const baseUrl = await sandbox.getPreviewUrl({ port: previewPort });
        const fetchPreview = await sandbox.getFetch({ port: previewPort });

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

        const fetched = await fetchPreview("/preview-ok.txt");
        expect(await fetched.text()).toContain(PREVIEW_BODY);
      },
      60000,
    );
  });
