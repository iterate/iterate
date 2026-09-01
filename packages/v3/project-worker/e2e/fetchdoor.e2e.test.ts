// prove_fetchdoor.mjs — cook-1 proof 4 + 6: the seeded site over the ONE fetch door (/cap) as a `code`
// mount (the web→code fold), including a WS upgrade through /cap; and the deleted routes fall through.
// (was proofs/prove_fetchdoor.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

// The raw HTTP/WS routes (/cap, /call, /ws, /version) have no itx method — they exercise the worker's
// edge routing directly, so they fetch the LOCAL worker booted by global-setup (WORKER_BASE_URL).
const base = (): string => {
  const u = process.env.WORKER_BASE_URL;
  if (!u) throw new Error("WORKER_BASE_URL unset — the e2e globalSetup/setup did not run");
  return u.replace(/\/+$/, "");
};
const wsBase = (): string => base().replace(/^http/, "ws");

// Node's global (undici) WebSocket, typed EYEBALL-side: the workers-types server WebSocket (which
// wins in tsconfig.tests.json) has no onopen/onmessage/onerror handler properties.
type EyeballWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
};
const openWs = (url: string): EyeballWebSocket => new WebSocket(url) as unknown as EyeballWebSocket;

const CAP = encodeURIComponent("itx.site"); // the fetch door resolves an itx expression (the ONE addressing form)

test("fetchdoor: seeded site over /cap (GET + WS), deleted routes fall through, /version + hostState still work", async () => {
  const ctx = freshCtx("cook1");

  // Mount the seeded /site.js on the fetch door: a mount whose target is a stateless dynamic worker
  // (its .fetch serves /cap). `type:'code'` provisioning was folded into the ONE provide door —
  // a capability is an itx EXPRESSION (load(src).getEntrypoint()), same as every other mount.
  const itx = bareItx(ctx);
  await seedSources(itx, ["site"]);
  await itx.provide("itx.site", "itx.load(\"itx.kv.get('src/site.js')\").getEntrypoint()");

  // ── 4a. GET through the one fetch door ──
  const page = await fetch(`${base()}/cap?cap=${CAP}&ctx=${ctx}`);
  const html = await page.text();
  // 4a. GET /cap?cap=itx.site → 200 HTML (code mount on the fetch lane)
  expect(page.status).toBe(200);
  expect(html).toContain("dynamic web capability");

  // ── 4b. WebSocket upgrade through /cap → echo ──
  const wsResult = await new Promise<string>((resolve) => {
    const ws = openWs(`${wsBase()}/cap?cap=${CAP}&ctx=${ctx}`);
    const timer = setTimeout(() => resolve("TIMEOUT"), 15000);
    ws.onopen = () => ws.send("hello-from-eyeball");
    ws.onmessage = (e) => {
      clearTimeout(timer);
      ws.close();
      resolve(e.data as string);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("WS-ERROR");
    };
  });
  // 4b. WS upgrade through /cap → echo (web→code fold, 101 through the graph)
  expect(wsResult).toBe("site-echo:hello-from-eyeball");

  // ── 6. deleted routes fall through to help text; /version + hostState still work ──
  const call = await fetch(`${base()}/call?path=itx.whoami&ctx=${ctx}`);
  const callBody = await call.text();
  // 6a. /call falls through to help text
  expect(callBody).toContain("project-worker —");
  expect(callBody).not.toContain('"ok"');

  const wsRoute = await fetch(`${base()}/ws?ctx=${ctx}`);
  const wsBody = await wsRoute.text();
  // 6b. /ws falls through to help text
  expect(wsBody).toContain("project-worker —");

  const wsUpgrade = await new Promise<string>((resolve) => {
    const ws = openWs(`${wsBase()}/ws?ctx=${ctx}`);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve("NO-101");
    }, 8000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve("UPGRADED");
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve("NO-101");
    };
  });
  // 6c. a bare WS upgrade to /ws no longer echoes (demo deleted)
  expect(wsUpgrade).toBe("NO-101");

  const version = (await (await fetch(`${base()}/version`)).text()).trim();
  // 6d. /version still works (tag-agnostic — never goes stale)
  expect(version.length).toBeGreaterThan(0);

  // 6e. the old HTTP /state was folded into itx.hostState() (the ONE observability door) — still works
  const stateBody = await itx.hostState();
  expect(typeof stateBody.incarnation).toBe("number");
});
