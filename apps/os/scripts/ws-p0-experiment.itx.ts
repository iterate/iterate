// Body for: pnpm cli itx run --file apps/os/scripts/ws-p0-experiment.itx.ts
// P0: can sandbox outbound WSS complete through HTTPS MITM (direct-fetch mode)?

const slug = `ws-p0-${crypto.randomUUID().slice(0, 8)}`;
const project = itx.projects.create({ slug });
const { path } = await project.sandboxes.create({
  name: `ws-probe-${crypto.randomUUID().slice(0, 6)}`,
  instanceType: "lite",
});
const s = await project.sandboxes.get(path);

// Baseline: plain HTTPS + DNS
const baseline = await s.exec(
  `curl -sS -o /dev/null -w "example_http=%{http_code} ip=%{remote_ip}\\n" --max-time 15 https://example.com; ` +
    `getent hosts example.com 2>/dev/null || true; ` +
    `getent hosts ws.postman-echo.com 2>/dev/null || true; ` +
    `getent hosts echo.websocket.events 2>/dev/null || true; ` +
    `curl -sS -o /dev/null -w "postman_http=%{http_code}\\n" --max-time 15 https://ws.postman-echo.com/ 2>&1 || true`,
);

const targets = ["wss://ws.postman-echo.com/raw", "wss://echo.websocket.events/"];

const probeSource = `
const targets = ${JSON.stringify(targets)};
const out = [];
for (const url of targets) {
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(value);
    };
    const t = setTimeout(() => finish({ url, ok: false, stage: "timeout" }), 15000);
    try {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        try { ws.send("iterate-ws-p0"); }
        catch (e) { finish({ url, ok: false, stage: "send", err: String(e) }); }
      });
      ws.addEventListener("message", (ev) => {
        try { ws.close(); } catch {}
        finish({ url, ok: true, stage: "message", data: String(ev.data).slice(0, 120) });
      });
      ws.addEventListener("error", (ev) => {
        finish({ url, ok: false, stage: "error", err: String(ev.message || ev.type || "error") });
      });
      ws.addEventListener("close", (ev) => {
        setTimeout(() => {
          finish({ url, ok: false, stage: "close", code: ev.code, reason: String(ev.reason || "") });
        }, 50);
      });
    } catch (e) {
      finish({ url, ok: false, stage: "throw", err: String(e) });
    }
  });
  out.push(result);
}
console.log(JSON.stringify(out));
`.trim();

await s.writeFile("/tmp/ws-p0-probe.mjs", probeSource);
const probe = await s.exec("node /tmp/ws-p0-probe.mjs");

// Raw upgrade probe to postman (if DNS works)
const curlUpgrade = await s.exec(
  `curl -sS -i --http1.1 --max-time 15 ` +
    `-H "Connection: Upgrade" -H "Upgrade: websocket" ` +
    `-H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" ` +
    `https://ws.postman-echo.com/raw 2>&1 | head -40`,
);

// Peer cert via node for postman
const cert = await s.exec(`node --input-type=module -e '
import tls from "node:tls";
for (const host of ["ws.postman-echo.com", "example.com"]) {
  await new Promise((resolve) => {
    const sock = tls.connect(443, host, { servername: host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate();
      console.log(JSON.stringify({ host, issuer: c.issuer, subject: c.subject }));
      sock.end();
      resolve();
    });
    sock.on("error", (e) => { console.log(JSON.stringify({ host, err: String(e) })); resolve(); });
    setTimeout(() => resolve(), 8000);
  });
}
'`);

try {
  await s.destroy();
} catch {
  // best-effort
}

return {
  slug,
  path,
  baseline: baseline.stdout,
  probeExit: probe.exitCode,
  probeOut: probe.stdout,
  probeErr: probe.stderr,
  cert: cert.stdout.trim(),
  curlUpgrade: curlUpgrade.stdout.slice(0, 2000),
};
