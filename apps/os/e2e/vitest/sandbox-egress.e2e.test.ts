// Deployed Firecracker proof; local fixtures are not container-reachable.

import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
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
import { adminSecret, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

const EGRESS_PROOF_HEADER = "x-itx-egress-proof";

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

    const material = `sandbox-egress-material-${crypto.randomUUID()}`;
    const secretPath = `/secrets/sandbox-egress/${crypto.randomUUID()}`;
    await using bareWebSocketEcho = await startWebSocketEcho();
    await using authenticatedWebSocketEcho = await startWebSocketEcho({
      expectedAuthorization: `Bearer ${material}`,
    });
    const bareWebSocketUrl = new URL(bareWebSocketEcho.url);
    bareWebSocketUrl.protocol = "wss:";
    await proveFixtureCloseRoundTrip(bareWebSocketUrl.href);
    const authenticatedWebSocketUrl = new URL(authenticatedWebSocketEcho.url);
    authenticatedWebSocketUrl.protocol = "wss:";
    using secret = project.secrets.get(secretPath);
    await secret.update({
      egress: { urls: [echoOrigin, new URL(authenticatedWebSocketEcho.url).origin] },
      material,
    });
    await waitForCondition(async () => (await secret.__describe()).hasMaterial, {
      description: "secret processor to fold the material",
    });

    const sandboxName = `egress-proof-${crypto.randomUUID()}`;
    const secretPlaceholder = `getSecret({ path: "${secretPath}" })`;
    const proofHeader = `${EGRESS_PROOF_HEADER}: Bearer getSecret({ path: "${secretPath}" })`;
    const curlCommand = `curl -sS --max-time 60 ${shellDoubleQuote(echo.url)} -H ${shellDoubleQuote(proofHeader)}`;
    const issuerCommand = `echo | openssl s_client -connect ${echoUrl.hostname}:443 -servername ${echoUrl.hostname} 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo no-openssl`;

    const { path: sandboxPath } = await project.sandboxes.create({
      env: { CODEX_API_KEY: secretPlaceholder },
      instanceType: "lite",
      name: sandboxName,
    });
    const sandbox = (await project.sandboxes.get(
      sandboxPath,
    )) as unknown as RpcStub<SandboxLiteDurableObject>;

    try {
      const echoResult = await sandbox.exec(curlCommand, { timeout: 90_000 });
      const issuer = await sandbox.exec(issuerCommand, { timeout: 30_000 });

      expect(echoResult).toMatchObject({ exitCode: 0 });

      expect(issuer.stdout).toMatch(/Cloudflare/i);
      expect(issuer.stdout).toMatch(/Intercept CA/i);

      const echoed = JSON.parse(echoResult.stdout) as { headers?: Record<string, string> };
      expect(echoed.headers?.[EGRESS_PROOF_HEADER]).toBe(`Bearer ${material}`);

      const { result: globalResult, stdout: globalProbeOutput } = await runWebSocketProbe(
        sandbox,
        "global-websocket-proof",
        globalWebSocketProbeScript(bareWebSocketUrl.href),
      );
      expect(
        globalResult,
        JSON.stringify({
          fixtureCloses: bareWebSocketEcho.closeEvents,
          fixtureHandshakes: bareWebSocketEcho.authHeaders.length,
          probe: globalResult,
        }),
      ).toMatchObject({
        closeObserved: null,
        messages: [WEBSOCKET_ECHO_GREETING, GLOBAL_WEBSOCKET_MESSAGE],
      });
      expect(bareWebSocketEcho).toMatchObject({ authHeaders: ["", ""] });
      await waitForCondition(
        async () =>
          bareWebSocketEcho.closeEvents.some(
            (event) => event.code === 1000 && event.reason === "global-proof-complete",
          ),
        { description: "built-in WebSocket close frame to reach the fixture" },
      );

      const installWs = await sandbox.exec(
        `npm install --prefix /tmp/websocket-proof --no-audit --no-fund --ignore-scripts --package-lock=false ws@${WS_VERSION}`,
        { timeout: 120_000 },
      );
      expect(installWs, installWs.stderr).toMatchObject({ exitCode: 0 });

      const { result: bareWsResult, stdout: bareWsProbeOutput } = await runWebSocketProbe(
        sandbox,
        "ws-bare-websocket-proof",
        wsProbeScript(bareWebSocketUrl.href, false),
      );
      expectReleasedWsResult(bareWsResult);
      expect(bareWsResult).toMatchObject({ nodeVersion: globalResult.nodeVersion });
      expect(bareWebSocketEcho).toMatchObject({ authHeaders: ["", "", ""] });

      const { result: wsResult, stdout: wsProbeOutput } = await runWebSocketProbe(
        sandbox,
        "ws-websocket-proof",
        wsProbeScript(authenticatedWebSocketUrl.href),
      );
      expectReleasedWsResult(wsResult);

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
      expect(echoResult.stdout).not.toContain(`path: "${secretPath}"`);
      expect(globalProbeOutput).not.toContain(material);
      expect(bareWsProbeOutput).not.toContain(material);
      expect(wsProbeOutput).not.toContain(material);
      const sandboxKey = await sandbox.exec('printf %s "$CODEX_API_KEY"', { timeout: 10_000 });
      expect(sandboxKey).toMatchObject({ stdout: secretPlaceholder });
      const described = await secret.__describe();
      expect(JSON.stringify(described)).not.toContain(material);
      await waitForCondition(async () => (await secret.__describe()).audit.usedCount >= 2, {
        description: "secret usage audit to record the substitution",
      });
    } finally {
      await sandbox.destroy().catch(() => {});
    }
  },
);

// Wrap a string as a single POSIX-shell double-quoted argument. The header
// value carries `"` (inside `getSecret({ path: "..." })`), so `"` and the
// other shell-active characters must be escaped for `exec`'s shell.
function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function jsonFromCommand(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`command did not emit JSON: ${stdout}`);
  return JSON.parse(stdout.slice(start));
}

type WebSocketProbeResult = {
  binaryHex?: string | null;
  closeObserved: { code: number; reason: string } | null;
  error?: string;
  messages: string[];
  nodeVersion: string;
  protocol?: string;
};

async function runWebSocketProbe(
  sandbox: RpcStub<SandboxLiteDurableObject>,
  name: string,
  script: string,
): Promise<{ result: WebSocketProbeResult; stdout: string }> {
  const path = `/tmp/${name}.mjs`;
  await sandbox.writeFile(path, script);
  const command = await sandbox.exec(`node ${path}`, { timeout: 45_000 });
  expect(command, command.stderr).toMatchObject({ exitCode: 0 });
  return {
    result: jsonFromCommand(command.stdout) as WebSocketProbeResult,
    stdout: command.stdout,
  };
}

function expectReleasedWsResult(result: WebSocketProbeResult): void {
  expect(result).toMatchObject({
    binaryHex: WS_BINARY_HEX,
    closeObserved: { code: 4001, reason: "ws-proof-complete" },
    messages: [WEBSOCKET_ECHO_GREETING, WS_TEXT_MESSAGE],
    protocol: WEBSOCKET_ECHO_PROTOCOL,
  });
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
