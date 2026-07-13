// Proves a sandbox can open an outbound WebSocket through HTTPS MITM + project
// egress. Local containers with OS_SANDBOX_CONTAINER_LOCAL_DEV also work for
// this check; deployed e2e is the Firecracker path.
//
// Prefer direct sandbox RPC (create/exec/destroy) over capabilityHost.runScript:
// WSS egress re-enters the Project DO while the script would also be on that DO.
//
// Docs: apps/os/docs/sandbox-websocket-egress.md

import { describe, expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

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

/**
 * Opt-in: cold sandbox + public wss is slow (~50s+) and can stretch the
 * preview e2e wall clock. Default off in CI; set RUN_SANDBOX_WS_E2E=1 to run.
 * Local proof already covered pair-bridge + Intercept CA (see docs).
 */
function sandboxWsE2eEnabled(): boolean {
  return process.env.RUN_SANDBOX_WS_E2E === "1" || process.env.RUN_SANDBOX_WS_E2E === "true";
}

/** Public echo that speaks WebSocket over TLS (reliable under MITM). */
const WSS_ECHO_URL = "wss://ws.postman-echo.com/raw";
const WSS_ECHO_HOST = "ws.postman-echo.com";

/** Node global WebSocket under interceptHttps + project pair-bridge. */
const PROBE_SCRIPT = `
const url = ${JSON.stringify(WSS_ECHO_URL)};
let ws;
const result = await new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    try { ws?.close(); } catch {}
    resolve(value);
  };
  const t = setTimeout(() => finish({ ok: false, stage: "timeout" }), 30000);
  try {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      try { ws.send("iterate-ws-p0"); } catch (e) {
        finish({ ok: false, stage: "send", err: String(e) });
      }
    });
    ws.addEventListener("message", (ev) => {
      finish({ ok: true, stage: "message", data: String(ev.data).slice(0, 200) });
    });
    ws.addEventListener("error", (ev) => {
      finish({ ok: false, stage: "error", err: String(ev.message || ev.type || "error") });
    });
  } catch (e) {
    finish({ ok: false, stage: "throw", err: String(e) });
  }
});
console.log(JSON.stringify(result));
// Always exit so a half-open socket cannot keep sandbox.exec hung.
process.exit(0);
`.trim();

describe("sandbox websocket egress", () => {
  test.skipIf(deployedBaseUrl() === null || !sandboxWsE2eEnabled())(
    "outbound wss through container HTTPS MITM and project egress",
    { timeout: 300_000 },
    async () => {
      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({
        slug: `sandbox-ws-egress-${crypto.randomUUID().slice(0, 8)}`,
      });

      const sandboxName = `ws-egress-${crypto.randomUUID().slice(0, 8)}`;
      const { path: sandboxPath } = await project.sandboxes.create({
        name: sandboxName,
        instanceType: "lite",
      });
      const sandbox = await project.sandboxes.get(sandboxPath);

      try {
        await sandbox.writeFile("/tmp/ws-p0.mjs", PROBE_SCRIPT);
        const probe = await sandbox.exec("node /tmp/ws-p0.mjs");

        expect(probe.exitCode).toBe(0);
        const parsed = JSON.parse(probe.stdout.trim().split("\n").at(-1)!) as {
          ok: boolean;
          stage: string;
          data?: string;
          err?: string;
          code?: number;
        };

        if (!parsed.ok) {
          throw new Error(
            `sandbox outbound WSS failed under MITM: ${JSON.stringify(parsed)} stderr=${probe.stderr.slice(0, 500)}`,
          );
        }
        expect(parsed.stage).toBe("message");
        expect(parsed.data).toContain("iterate-ws-p0");

        // MITM + ordinary HTTPS on the same sandbox (same as manual itx proof).
        const https = await sandbox.exec(
          `node --input-type=module -e ${JSON.stringify(
            'const r=await fetch("https://httpbin.org/get");console.log(JSON.stringify({status:r.status,ok:r.ok}))',
          )}`,
        );
        const httpsParsed = JSON.parse(https.stdout.trim()) as { status: number; ok: boolean };
        expect(httpsParsed.ok).toBe(true);
        expect(httpsParsed.status).toBe(200);

        // Peer cert issuer when openssl is present (stock image usually has it).
        const issuer = await sandbox.exec(
          [
            `echo | openssl s_client -connect ${WSS_ECHO_HOST}:443 -servername ${WSS_ECHO_HOST} -timeout 10 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null || true`,
          ].join(""),
        );
        const certIssuer = issuer.stdout.trim();
        if (certIssuer.length > 0) {
          expect(certIssuer).toMatch(/Cloudflare|Intercept/i);
        }
      } finally {
        await sandbox.destroy().catch(() => {});
      }
    },
  );
});
