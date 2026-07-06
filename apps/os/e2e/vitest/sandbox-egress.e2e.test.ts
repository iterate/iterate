// Proves the sandbox egress contract end-to-end against a REAL deployed worker
// with real Firecracker containers (local dev is skipped — its 127.0.0.1 echo
// is unreachable from a container, and `pnpm dev` runs containers off by
// default). One request made from INSIDE a sandbox container proves all three
// properties at once:
//
//   1. MITM interception — the TLS handshake the container sees is terminated
//      by the Cloudflare container Intercept CA, not the origin's real cert.
//      That only happens when `interceptHttps` routes HTTPS through the
//      container proxy → our `static outbound` handler.
//   2. Routing through the project egress fetcher — the request reaches the
//      owning project's Durable Object (the same decision point dynamic
//      workers' `globalOutbound` uses), because...
//   3. Secret substitution — the echo sees the real secret MATERIAL in place of
//      the `getSecret({ path })` placeholder the container sent. Substitution
//      only happens server-side in the Project DO's egress path; the container
//      never holds the material.
//
// If a sandbox reached the internet directly (bypassing the proxy), the cert
// would be the origin's and the placeholder would arrive unsubstituted.

import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { startEgressEcho } from "./itx-capability-fixtures.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The deployed egress-echo fixture (served by the worker under test) is
// reachable from inside a container over the public internet; the local-dev
// fixture binds 127.0.0.1 on the test runner and is not. Skip local dev.
function deployedBaseUrl(): string | null {
  const raw = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return null;
  return url.toString();
}

// Wrap a string as a single POSIX-shell double-quoted argument. The header
// value carries `"` (inside `getSecret({ path: "..." })`), so `"` and the
// other shell-active characters must be escaped for `exec`'s shell.
function shellDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

const EGRESS_PROOF_HEADER = "x-itx-egress-proof";

describe("sandbox egress", () => {
  test.skipIf(deployedBaseUrl() === null)(
    "is MITM-intercepted and routed through project egress with secret substitution",
    { timeout: 240_000 },
    async () => {
      const echo = await startEgressEcho();
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
      using secret = project.secrets.get(secretPath);
      await secret.update({ egress: { urls: [echoOrigin] }, material });
      await waitForCondition(async () => (await secret.describe()).hasMaterial, {
        description: "secret processor to fold the material",
      });

      // The sandbox lives at an agent-sandbox-shaped path — the same
      // primitive an agent's `itx.sandbox` resolves to (agentSandboxPath).
      // Getting it needs no container; the curl below boots one.
      const sandboxPath = `/sandboxes/cloudflare/agents/egress-proof/${crypto.randomUUID()}`;
      const proofHeader = `${EGRESS_PROOF_HEADER}: Bearer getSecret({ path: "${secretPath}" })`;
      const curlCommand = `curl -sS --max-time 60 ${shellDoubleQuote(echo.url)} -H ${shellDoubleQuote(proofHeader)}`;
      // The issuer of the cert the container is presented for the echo host:
      // the interception CA when HTTPS is MITM'd, the origin's real CA if not.
      const issuerCommand = `echo | openssl s_client -connect ${echoUrl.hostname}:443 -servername ${echoUrl.hostname} 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || echo no-openssl`;

      const script = [
        "async (itx) => {",
        `  const sandbox = await itx.sandboxes.get(${JSON.stringify(sandboxPath)});`,
        `  const echo = await sandbox.exec(${JSON.stringify(curlCommand)});`,
        `  const issuer = await sandbox.exec(${JSON.stringify(issuerCommand)});`,
        "  return { body: echo.stdout, exitCode: echo.exitCode, certIssuer: issuer.stdout.trim() };",
        "}",
      ].join("\n");

      try {
        const { result } = await project.capabilityHost.runScript(script);
        const proof = result as { body: string; certIssuer: string; exitCode: number };

        expect(proof.exitCode).toBe(0);

        // (1) MITM: the container was handed the interception CA's cert, proving
        // the TLS session was terminated by the container proxy, not the origin.
        expect(proof.certIssuer).toMatch(/Cloudflare/i);
        expect(proof.certIssuer).toMatch(/Intercept CA/i);

        // (2)+(3) Routing + substitution: the echo — reached only via the
        // Project DO egress path — saw the real material where the container
        // sent a `getSecret(...)` placeholder.
        const echoed = JSON.parse(proof.body) as { headers?: Record<string, string> };
        expect(echoed.headers?.[EGRESS_PROOF_HEADER]).toBe(`Bearer ${material}`);

        // The material never transited the sandbox: the script and its egress
        // carried only the placeholder, and describe() still hides the value.
        expect(proof.body).not.toContain(`path: "${secretPath}"`);
        const described = await secret.describe();
        expect(JSON.stringify(described)).not.toContain(material);
        await waitForCondition(async () => (await secret.describe()).audit.usedCount >= 1, {
          description: "secret usage audit to record the substitution",
        });
      } finally {
        // Return the container's instance slot instead of waiting out sleepAfter.
        await project.capabilityHost
          .runScript(
            `async (itx) => { await (await itx.sandboxes.get(${JSON.stringify(sandboxPath)})).destroy(); }`,
          )
          .catch(() => {});
        await echo.close();
      }
    },
  );
});
