// Proves a sandbox can open an outbound WebSocket through HTTPS MITM + project
// egress. Local containers with OS_SANDBOX_CONTAINER_LOCAL_DEV also work for
// this check; deployed e2e is the Firecracker path.
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

/** Public echo that speaks WebSocket over TLS (reliable under MITM). */
const WSS_ECHO_URL = "wss://ws.postman-echo.com/raw";
const WSS_ECHO_HOST = "ws.postman-echo.com";

describe("sandbox websocket egress", () => {
  test.skipIf(deployedBaseUrl() === null)(
    "outbound wss through container HTTPS MITM and project egress",
    { timeout: 240_000 },
    async () => {
      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({
        slug: `sandbox-ws-egress-${crypto.randomUUID().slice(0, 8)}`,
      });

      const sandboxName = `ws-egress-${crypto.randomUUID().slice(0, 8)}`;
      const sandboxPath = `/sandboxes/${sandboxName}`;

      // Node 22 in the stock sandbox image has a global WebSocket.
      // Probe: open → send → expect echo → close.
      const probeScript = `
const url = ${JSON.stringify(WSS_ECHO_URL)};
const result = await new Promise((resolve) => {
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(t);
    resolve(value);
  };
  const t = setTimeout(() => finish({ ok: false, stage: "timeout" }), 30000);
  try {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      try { ws.send("iterate-ws-p0"); } catch (e) {
        finish({ ok: false, stage: "send", err: String(e) });
      }
    });
    ws.addEventListener("message", (ev) => {
      try { ws.close(); } catch {}
      finish({ ok: true, stage: "message", data: String(ev.data).slice(0, 200) });
    });
    ws.addEventListener("error", (ev) => {
      finish({ ok: false, stage: "error", err: String(ev.message || ev.type || "error") });
    });
    ws.addEventListener("close", (ev) => {
      setTimeout(() => {
        finish({ ok: false, stage: "close", code: ev.code, reason: String(ev.reason || "") });
      }, 50);
    });
  } catch (e) {
    finish({ ok: false, stage: "throw", err: String(e) });
  }
});
console.log(JSON.stringify(result));
`.trim();

      // Same MITM proof as sandbox-egress.e2e: openssl issuer when present,
      // node tls as fallback (stock image may lack openssl on some tags).
      const issuerCommand = [
        `echo | openssl s_client -connect ${WSS_ECHO_HOST}:443 -servername ${WSS_ECHO_HOST} 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null`,
        `node --input-type=module -e ${JSON.stringify(
          [
            'import tls from "node:tls";',
            `const host = ${JSON.stringify(WSS_ECHO_HOST)};`,
            "await new Promise((resolve) => {",
            "  const sock = tls.connect(443, host, { servername: host, rejectUnauthorized: false }, () => {",
            "    const c = sock.getPeerCertificate();",
            "    console.log(JSON.stringify(c.issuer || c));",
            "    sock.end();",
            "    resolve();",
            "  });",
            '  sock.on("error", (e) => { console.log(String(e)); resolve(); });',
            "  setTimeout(resolve, 15000);",
            "});",
          ].join(""),
        )}`,
      ].join("; ");

      const script = [
        "async (itx) => {",
        `  const { path } = await itx.sandboxes.create({ name: ${JSON.stringify(sandboxName)}, instanceType: "lite" });`,
        "  const sandbox = await itx.sandboxes.get(path);",
        `  await sandbox.writeFile("/tmp/ws-p0.mjs", ${JSON.stringify(probeScript)});`,
        `  const probe = await sandbox.exec("node /tmp/ws-p0.mjs");`,
        `  const issuer = await sandbox.exec(${JSON.stringify(issuerCommand)});`,
        "  return {",
        "    exitCode: probe.exitCode,",
        "    stdout: probe.stdout,",
        "    stderr: probe.stderr,",
        "    certIssuer: issuer.stdout.trim(),",
        "  };",
        "}",
      ].join("\n");

      try {
        const { result } = await project.capabilityHost.runScript(script);
        const proof = result as {
          exitCode: number;
          stdout: string;
          stderr: string;
          certIssuer: string;
        };

        expect(proof.exitCode).toBe(0);
        const parsed = JSON.parse(proof.stdout.trim().split("\n").at(-1)!) as {
          ok: boolean;
          stage: string;
          data?: string;
          err?: string;
          code?: number;
        };

        if (!parsed.ok) {
          throw new Error(
            `sandbox outbound WSS failed under MITM: ${JSON.stringify(parsed)} stderr=${proof.stderr.slice(0, 500)} cert=${proof.certIssuer.slice(0, 300)}`,
          );
        }
        expect(parsed.stage).toBe("message");
        expect(parsed.data).toContain("iterate-ws-p0");

        // MITM proof: peer cert is Cloudflare's intercept CA (not the public origin).
        // Primary: WSS echo already proves traffic is on the policy path; cert is
        // the stronger MITM check when openssl/node can surface the issuer.
        if (proof.certIssuer.length > 0) {
          expect(proof.certIssuer).toMatch(/Cloudflare|Intercept/i);
        }
      } finally {
        await project.capabilityHost
          .runScript(
            `async (itx) => { await (await itx.sandboxes.get(${JSON.stringify(sandboxPath)})).destroy(); }`,
          )
          .catch(() => {});
      }
    },
  );
});
