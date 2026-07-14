// Proves the sandbox egress contract end-to-end against a REAL deployed worker
// with real Firecracker containers (local dev is skipped — its 127.0.0.1 echo
// is unreachable from a container, and `pnpm dev` runs containers off by
// default). Requests made from INSIDE one sandbox container prove all three
// properties together:
//
//   1. MITM interception — the TLS handshake the container sees is terminated
//      by the Cloudflare container Intercept CA, not the origin's real cert.
//      That only happens when `interceptHttps` routes HTTPS through the
//      container proxy → our `static outbound` handler.
//   2. Routing through the project egress fetcher — the request reaches the
//      owning project's Durable Object (the same decision point dynamic
//      workers' `globalOutbound` uses), because...
//   3. Secret substitution — the HTTP and WebSocket fixtures see the real
//      secret MATERIAL in place of the `getSecret(path)` placeholder the
//      container sent. Substitution only happens server-side in the Project
//      DO's egress path; the container never holds the material.
//
// If a sandbox reached the internet directly (bypassing the proxy), the cert
// would be the origin's and the placeholder would arrive unsubstituted.

import type { RpcStub } from "capnweb";
import { describe, expect, test } from "vitest";
import type { SandboxLiteDurableObject } from "../../src/domains/sandboxes/cloudflare/cloudflare-sandbox-durable-object.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  startEgressEcho,
  startWebSocketEcho,
  WEBSOCKET_ECHO_GREETING,
  WEBSOCKET_ECHO_PROTOCOL,
} from "./itx-capability-fixtures.ts";
import {
  GLOBAL_WEBSOCKET_MESSAGE,
  globalWebSocketProbeScript,
  WS_BINARY_HEX,
  WS_TEXT_MESSAGE,
  WS_VERSION,
  wsProbeScript,
} from "./sandbox-websocket-proof-programs.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Deployed runs publish egress-echo through apps/tunnels, so a sandbox
// container can reach it over the public internet. Local dev binds 127.0.0.1
// on the test runner and is not reachable from the container. Skip local dev.
function deployedBaseUrl(): string | null {
  const raw = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    url.hostname.endsWith(".localhost")
  ) {
    return null;
  }
  return url.toString();
}

// Wrap a string as a single POSIX-shell double-quoted argument. The header
// value carries `"` (inside `getSecret({ path: "..." })`), so `"` and the
// other shell-active characters must be escaped for `exec`'s shell.
function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

const EGRESS_PROOF_HEADER = "x-itx-egress-proof";
function jsonFromCommand(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`command did not emit JSON: ${stdout}`);
  return JSON.parse(stdout.slice(start));
}

async function proveFixtureCloseRoundTrip(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const messages: string[] = [];
    const socket = new WebSocket(url);
    const timeout = setTimeout(
      () => reject(new Error("fixture WebSocket close timed out")),
      10_000,
    );
    socket.addEventListener("open", () => socket.send("fixture-control"));
    socket.addEventListener("message", (event) => {
      messages.push(String(event.data));
      if (messages.includes("fixture-control")) socket.close(3999, "fixture-control-complete");
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      try {
        expect(messages).toEqual([WEBSOCKET_ECHO_GREETING, "fixture-control"]);
        expect({ code: event.code, reason: event.reason }).toEqual({
          code: 3999,
          reason: "fixture-control-complete",
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture WebSocket control failed"));
    });
  });
}

describe("sandbox egress", () => {
  test.skipIf(deployedBaseUrl() === null)(
    "is MITM-intercepted and routed through project egress with secret substitution",
    { timeout: 180_000 },
    async () => {
      await using echo = await startEgressEcho();
      const echoUrl = new URL(echo.url);
      const echoOrigin = echoUrl.origin;

      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({ slug: `sandbox-egress-${crypto.randomUUID()}` });

      // A secret whose material may be substituted into requests to the echo
      // origin. The container only ever holds the placeholder below; this
      // material lives server-side and must never transit the sandbox.
      const material = `sandbox-egress-material-${crypto.randomUUID()}`;
      const secretPath = `/secrets/sandbox-egress/${crypto.randomUUID()}`;
      await using controlWebSocketEcho = await startWebSocketEcho();
      await using bareWebSocketEcho = await startWebSocketEcho();
      await using authenticatedWebSocketEcho = await startWebSocketEcho({
        expectedAuthorization: `Bearer ${material}`,
      });
      const bareWebSocketUrl = new URL(bareWebSocketEcho.url);
      bareWebSocketUrl.protocol = "wss:";
      const controlWebSocketUrl = new URL(controlWebSocketEcho.url);
      controlWebSocketUrl.protocol = "wss:";
      await proveFixtureCloseRoundTrip(controlWebSocketUrl.href);
      const authenticatedWebSocketUrl = new URL(authenticatedWebSocketEcho.url);
      authenticatedWebSocketUrl.protocol = "wss:";
      using secret = project.secrets.get(secretPath);
      await secret.update({
        // Secret pins intentionally use the HTTP(S) origin vocabulary shared
        // by every egress fetch. `Upgrade: websocket` selects WSS; it does not
        // create a separate secret-policy scheme.
        egress: { urls: [echoOrigin, new URL(authenticatedWebSocketEcho.url).origin] },
        material,
      });
      await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
        description: "secret processor to fold the material",
      });

      // Sandboxes are pets: created explicitly, then addressed by the path
      // create returns (names are one path segment). Creating needs no
      // container; the curl below boots one.
      const sandboxName = `egress-proof-${crypto.randomUUID()}`;
      const secretPlaceholder = `getSecret({ path: "${secretPath}" })`;
      const proofHeader = `${EGRESS_PROOF_HEADER}: Bearer getSecret({ path: "${secretPath}" })`;
      const curlCommand = `curl -sS --max-time 60 ${shellDoubleQuote(echo.url)} -H ${shellDoubleQuote(proofHeader)}`;
      // The issuer of the cert the container is presented for the echo host:
      // the interception CA when HTTPS is MITM'd, the origin's real CA if not.
      const issuerCommand = `echo | openssl s_client -connect ${echoUrl.hostname}:443 -servername ${echoUrl.hostname} 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo no-openssl`;

      const { path: sandboxPath } = await project.sandboxes.create({
        env: { CODEX_API_KEY: secretPlaceholder },
        instanceType: "lite",
        name: sandboxName,
      });
      // The public CloudflareSandbox type intentionally leaves the SDK surface
      // opaque; direct RPC is required here so WSS can re-enter the Project DO.
      const sandbox = (await project.sandboxes.get(
        sandboxPath,
      )) as unknown as RpcStub<SandboxLiteDurableObject>;

      try {
        const echoResult = await sandbox.exec(curlCommand, { timeout: 90_000 });
        const issuer = await sandbox.exec(issuerCommand, { timeout: 30_000 });

        expect(echoResult.exitCode).toBe(0);

        // (1) MITM: the container was handed the interception CA's cert, proving
        // the TLS session was terminated by the container proxy, not the origin.
        expect(issuer.stdout).toMatch(/Cloudflare/i);
        expect(issuer.stdout).toMatch(/Intercept CA/i);

        // (2)+(3) Routing + substitution: the echo — reached only via the
        // Project DO egress path — saw the real material where the container
        // sent a `getSecret(...)` placeholder.
        const echoed = JSON.parse(echoResult.stdout) as { headers?: Record<string, string> };
        expect(echoed.headers?.[EGRESS_PROOF_HEADER]).toBe(`Bearer ${material}`);

        // Zero-configuration built-in client: ordinary bare WSS must work
        // through the same MITM without a proxy agent or custom trust flags.
        await sandbox.writeFile(
          "/tmp/global-websocket-proof.mjs",
          globalWebSocketProbeScript(bareWebSocketUrl.href),
        );
        const globalProbe = await sandbox.exec("node /tmp/global-websocket-proof.mjs", {
          timeout: 45_000,
        });
        expect(globalProbe.exitCode).toBe(0);
        const globalResult = jsonFromCommand(globalProbe.stdout) as {
          closeAttempted: boolean;
          closeObserved: { code: number; reason: string } | null;
          duplexOk: boolean;
          messages: string[];
          nodeVersion: string;
          opened: boolean;
          protocol: string;
          stage: string;
        };
        expect(
          globalResult,
          JSON.stringify({
            fixtureCloses: bareWebSocketEcho.closeEvents,
            fixtureHandshakes: bareWebSocketEcho.authHeaders.length,
            probe: globalResult,
          }),
        ).toMatchObject({
          closeAttempted: true,
          closeObserved: null,
          duplexOk: true,
          opened: true,
          protocol: "",
          stage: "messages",
        });
        expect(globalResult.messages).toEqual([WEBSOCKET_ECHO_GREETING, GLOBAL_WEBSOCKET_MESSAGE]);
        expect(bareWebSocketEcho.authHeaders).toEqual([""]);
        await waitForCondition(
          async () =>
            bareWebSocketEcho.closeEvents.some(
              (event) => event.code === 1000 && event.reason === "global-proof-complete",
            ),
          { description: "built-in WebSocket close frame to reach the fixture" },
        );

        // Install a real released program inside the sandbox. It receives no
        // Iterate-specific proxy or CA configuration.
        const installWs = await sandbox.exec(
          `npm install --prefix /tmp/websocket-proof --no-audit --no-fund --ignore-scripts --package-lock=false ws@${WS_VERSION}`,
          { timeout: 120_000 },
        );
        expect(installWs.exitCode, installWs.stderr).toBe(0);

        // Same bare fixture as the built-in client, now through released
        // `ws`. This isolates close behavior by client rather than egress hop.
        await sandbox.writeFile(
          "/tmp/ws-bare-websocket-proof.mjs",
          wsProbeScript(bareWebSocketUrl.href, false),
        );
        const bareWsProbe = await sandbox.exec("node /tmp/ws-bare-websocket-proof.mjs", {
          timeout: 45_000,
        });
        expect(bareWsProbe.exitCode).toBe(0);
        const bareWsResult = jsonFromCommand(bareWsProbe.stdout) as {
          binaryHex: string;
          closeAttempted: boolean;
          closeObserved: { code: number; reason: string } | null;
          messages: string[];
          nodeVersion: string;
          ok: boolean;
          protocol: string;
          stage: string;
        };
        expect(bareWsResult).toMatchObject({
          binaryHex: WS_BINARY_HEX,
          closeAttempted: true,
          closeObserved: { code: 4001, reason: "ws-proof-complete" },
          ok: true,
          protocol: WEBSOCKET_ECHO_PROTOCOL,
          stage: "close",
        });
        expect(bareWsResult.messages).toEqual([WEBSOCKET_ECHO_GREETING, WS_TEXT_MESSAGE]);
        expect(bareWsResult.nodeVersion).toBe(globalResult.nodeVersion);
        expect(bareWebSocketEcho.authHeaders).toEqual(["", ""]);

        await sandbox.writeFile(
          "/tmp/ws-websocket-proof.mjs",
          wsProbeScript(authenticatedWebSocketUrl.href),
        );
        const wsProbe = await sandbox.exec("node /tmp/ws-websocket-proof.mjs", {
          timeout: 45_000,
        });
        expect(wsProbe.exitCode).toBe(0);
        const wsResult = jsonFromCommand(wsProbe.stdout) as {
          binaryHex: string;
          closeAttempted: boolean;
          closeObserved: { code: number; reason: string } | null;
          messages: string[];
          nodeVersion: string;
          ok: boolean;
          protocol: string;
          stage: string;
        };
        expect(
          wsResult,
          JSON.stringify({
            fixtureAuthHeaders: authenticatedWebSocketEcho.authHeaders,
            fixtureCloses: authenticatedWebSocketEcho.closeEvents,
            probe: wsResult,
          }),
        ).toMatchObject({
          binaryHex: WS_BINARY_HEX,
          closeAttempted: true,
          closeObserved: { code: 4001, reason: "ws-proof-complete" },
          ok: true,
          protocol: WEBSOCKET_ECHO_PROTOCOL,
          stage: "close",
        });
        expect(wsResult.messages).toEqual([WEBSOCKET_ECHO_GREETING, WS_TEXT_MESSAGE]);

        const substitutedAuthorization = `Bearer ${material}`;
        expect(
          authenticatedWebSocketEcho.authHeaders.filter(
            (authorization) => authorization === substitutedAuthorization,
          ).length,
        ).toBeGreaterThanOrEqual(1);
        await waitForCondition(
          async () =>
            authenticatedWebSocketEcho.closeEvents.some(
              (event) => event.code === 4001 && event.reason === "ws-proof-complete",
            ),
          { description: "ws close frame to reach the fixture" },
        );
        // Known client/interceptor interaction: the direct fixture control
        // and released `ws` receive exact reciprocal closes, but Node's
        // built-in WebSocket in the same sandbox does not. Keep that loss
        // explicit until the built-in client also passes the exact assertion.
        // The material never transited the sandbox: the script and its egress
        // carried only the placeholder, and describe() still hides the value.
        expect(echoResult.stdout).not.toContain(`path: "${secretPath}"`);
        expect(globalProbe.stdout).not.toContain(material);
        expect(bareWsProbe.stdout).not.toContain(material);
        expect(wsProbe.stdout).not.toContain(material);
        const sandboxKey = await sandbox.exec('printf %s "$CODEX_API_KEY"', { timeout: 10_000 });
        expect(sandboxKey.stdout).toBe(secretPlaceholder);
        const described = await secret.__describe();
        expect(JSON.stringify(described)).not.toContain(material);
        await waitForCondition(async () => (await secret.__describe()).audit.usedCount >= 2, {
          description: "secret usage audit to record the substitution",
        });
      } finally {
        // Return the container's instance slot instead of waiting out sleepAfter.
        await sandbox.destroy().catch(() => {});
      }
    },
  );
});
