import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  base,
  browserHeaders,
  call as api,
  crypto,
  eventually,
  keyId,
  keyPair,
  project,
  setting,
  sign,
  timeout,
  type PublicEvent,
  type KeyPair,
} from "./support.ts";

const adminToken = process.env.EGRESS_E2E_ADMIN_TOKEN;
type Input = PublicEvent<Record<string, unknown>>;
type Pending = { code: string; requestId: string; fingerprint: string; expiresAt: number };

async function approval(
  context: string,
  id: string,
  requestId: string,
  fingerprint: string,
  allow: boolean,
  pair: KeyPair,
): Promise<Input> {
  const event: Input = {
    id,
    type: "approval.decided",
    data: { requestId, fingerprint, allow },
    provenance: { parents: [], signatures: [] },
  };
  event.provenance!.signatures = [await sign(context, event, pair)];
  return event;
}
async function append(id: string, event: Input, expected = 200) {
  return api(id, ["append"], [event], expected);
}
async function external(id: string, path: string, approvalId?: string) {
  const headers = new Headers(browserHeaders);
  if (approvalId) headers.set("x-project-core-approval", approvalId);
  const response = await fetch(new URL(`/p/${id}${path}`, base), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (response.headers.get("content-type") ?? "").includes("application/json")
      ? (JSON.parse(text) as unknown)
      : text,
    text,
  };
}
async function control(id: string, value: Record<string, string>, token = adminToken) {
  const url = new URL("/secrets", base);
  url.searchParams.set("project", id);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown, text };
}
async function mount(
  id: string,
  source: string,
  approval: unknown = { approval: "required", expiresInMs: 60_000 },
) {
  const policy = `export default { async fetch(request, env) {
    const target = await env.NEXT.to(new URL(request.url).hostname === '${id}.iterate'
      ? { kind: 'worker', source: { modules: { 'main.js': ${JSON.stringify(source)} } } }
      : { kind: 'network', approval: ${JSON.stringify(approval)} });
    return target.fetch(request);
  } }`;
  await append(
    id,
    setting(crypto.randomUUID(), "mount/fetch", {
      kind: "worker",
      source: { modules: { "main.js": policy } },
    }),
  );
}
function secret(id: string, origin: string, value = "synthetic-test-token") {
  return control(id, { name: "TEST_TOKEN", value, origin });
}
async function configured(expiresInMs = 60_000) {
  const id = project("project-core-egress");
  const pair = await keyPair();
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const app =
    'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { async fetch(request) { const incoming = new URL(request.url); const target = new URL("https://example.com/"); if (incoming.pathname === "/tamper") target.search = "changed=1"; const headers = new Headers(); const approval = request.headers.get("x-project-core-approval"); if (approval) headers.set("x-project-core-approval", approval); const response = await fetch(new Request(target, { headers })); return new Response(response.body, { status: response.status, headers: response.headers }) } }';
  await api(
    id,
    ["append"],
    [
      [
        setting("trust", "trust", {
          keys: [await keyId(key)],
          minLevel: 0,
          minSigners: 1,
        }),
      ],
    ],
  );
  await mount(id, app, { approval: "required", expiresInMs });
  return { id, pair };
}
function pending(value: unknown): Pending {
  assert.ok(value && typeof value === "object");
  const result = value as Partial<Pending>;
  assert.equal(result.code, "APPROVAL_REQUIRED", JSON.stringify(value));
  assert.equal(typeof result.requestId, "string");
  assert.equal(typeof result.fingerprint, "string");
  assert.equal(typeof result.expiresAt, "number");
  return result as Pending;
}

type HttpResponse = { status: number; body: unknown; text: string };
function assertFault(response: HttpResponse, status: number, code: string) {
  assert.equal(response.status, status, response.text);
  assert.ok(response.body && typeof response.body === "object" && "error" in response.body);
  const error = response.body.error;
  assert.ok(error && typeof error === "object" && "code" in error);
  assert.equal(error.code, code);
}

describe(
  "project core egress approval",
  { concurrency: false, skip: !base && "set WORKER_BASE_URL to a Worker with outbound HTTPS" },
  () => {
    test("revokes an outbound request while its body is still arriving", { timeout }, async () => {
      const id = project("project-core-streaming-policy");
      const policy = setting("policy", "mount/fetch", {
        kind: "worker",
        source: {
          modules: {
            "main.js": `export default { async fetch(request, env) {
          const target = await env.NEXT.to({ kind: 'network', approval: {
            approval: 'required', expiresInMs: 60000
          } });
          const scope = env.ITX.get();
          const body = new ReadableStream({ async start(controller) {
            controller.enqueue(new TextEncoder().encode('still arriving'));
            await scope.append({ id: 'entered', type: 'test.entered', data: {} });
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
              const page = await scope.readEvents({});
              if (page.events.some(event => event.id === 'replacement')) {
                controller.close(); return;
              }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            controller.error(new Error('test body release timed out'));
          } });
          return target.fetch(new Request('https://example.com/', { method: 'POST', body }));
        } }`,
          },
        },
      });
      await append(id, policy);
      const response = external(id, "/streaming");
      await Promise.race([
        eventually(async () => {
          const page = (await api(id, ["readEvents"], [{}])) as { events: { id: string }[] };
          return page.events.some((event) => event.id === "entered");
        }, "policy must enter before replacement"),
        response.then((result) =>
          assert.fail(`request completed before replacement: ${result.text}`),
        ),
      ]);
      await append(id, { ...policy, id: "replacement" });
      const result = await response;
      assertFault(result, 409, "FETCH_POLICY_CHANGED");
      const events = await api(id, ["readEvents"], [{}]);
      assert.ok(!JSON.stringify(events).includes("itx.system.egress."));
    });

    test(
      "invalidates an exact approval when its fetch policy is replaced",
      { timeout },
      async () => {
        const { id, pair } = await configured();
        const first = pending((await external(id, "/same")).body);
        const state = (await api(id, ["inspect"], [])) as {
          settings: { key: string; value: unknown }[];
        };
        const policy = state.settings.find((setting) => setting.key === "mount/fetch");
        assert.ok(policy);
        await append(id, setting("replacement", "mount/fetch", policy.value));
        await append(
          id,
          await approval(
            `${id}/`,
            "old-policy-approval",
            first.requestId,
            first.fingerprint,
            true,
            pair,
          ),
        );
        const stale = await external(id, "/same", first.requestId);
        assertFault(stale, 409, "APPROVAL_MISMATCH");
        assert.ok(
          !JSON.stringify(await api(id, ["readEvents"], [{}])).includes(
            "itx.system.egress.released",
          ),
        );
        const fresh = pending((await external(id, "/same")).body);
        assert.notEqual(fresh.fingerprint, first.fingerprint);
      },
    );

    test("requires a trusted signed exact approval and consumes it once", { timeout }, async () => {
      const { id, pair } = await configured();
      const first = pending((await external(id, "/same")).body);
      await append(
        id,
        await approval(`${id}/`, "allow", first.requestId, first.fingerprint, true, pair),
      );
      const released = await external(id, "/same", first.requestId);
      assert.equal(released.status, 200, released.text);
      const replay = await external(id, "/same", first.requestId);
      assertFault(replay, 409, "APPROVAL_USED");
    });

    test(
      "binds approval to an unchanged request and rejects denied or unsigned decisions",
      { timeout },
      async () => {
        const { id, pair } = await configured();
        const first = pending((await external(id, "/same")).body);
        const tampered = await external(id, "/tamper", first.requestId);
        assertFault(tampered, 409, "APPROVAL_MISMATCH");
        const unsigned: Input = {
          id: "unsigned",
          type: "approval.decided",
          data: { requestId: first.requestId, fingerprint: first.fingerprint, allow: true },
        };
        assert.equal(
          ((await append(id, unsigned, 403)) as { code: string }).code,
          "APPROVAL_SIGNER",
        );
        const denied = pending((await external(id, "/denied")).body);
        await append(
          id,
          await approval(`${id}/`, "deny", denied.requestId, denied.fingerprint, false, pair),
        );
        const rejected = await external(id, "/denied", denied.requestId);
        assertFault(rejected, 403, "APPROVAL_DENIED");
      },
    );

    test("expires pending approvals and rejects unknown retry ids", { timeout }, async () => {
      const { id, pair } = await configured(1_000);
      const missing = pending((await external(id, "/missing")).body);
      const unknown = await external(id, "/missing", crypto.randomUUID());
      assertFault(unknown, 409, "APPROVAL_MISMATCH");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const expired = await append(
        id,
        await approval(`${id}/`, "late", missing.requestId, missing.fingerprint, true, pair),
        409,
      );
      assert.equal((expired as { code: string }).code, "APPROVAL_EXPIRED");
    });

    test(
      "keeps synthetic secrets write-only and enforces their exact origin",
      { timeout, skip: !adminToken && "set EGRESS_E2E_ADMIN_TOKEN" },
      async () => {
        const { id } = await configured();
        const denied = await control(
          id,
          { name: "TEST_TOKEN", value: "synthetic-test-token", origin: "https://example.com" },
          "wrong-token",
        );
        assertFault(denied, 401, "CONTROL_AUTH");
        const stored = await secret(id, "https://www.example.com");
        assert.equal(stored.status, 200, stored.text);
        assert.deepEqual(stored.body, {
          result: { name: "TEST_TOKEN", origin: "https://www.example.com", revision: 1 },
        });
        assert.ok(
          !JSON.stringify(await api(id, ["readEvents"], [{ afterOffset: 0, limit: 128 }])).includes(
            "synthetic-test-token",
          ),
        );
        await mount(
          id,
          'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { fetch() { return fetch(new Request("https://example.com/", { headers: { authorization: "{{secret:TEST_TOKEN}}" } })) } }',
        );
        const mismatch = await external(id, "/origin");
        assertFault(mismatch, 403, "SECRET_ORIGIN");
        const permitted = await secret(id, "https://httpbin.org");
        assert.equal(permitted.status, 200, permitted.text);
        await mount(
          id,
          'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { fetch() { return fetch(new Request("https://httpbin.org/headers", { headers: { "x-synthetic-token": "{{secret:TEST_TOKEN}}" } })) } }',
          { approval: "none" },
        );
        const echo = await external(id, "/echo");
        assert.equal(echo.status, 200, echo.text);
        assert.equal(
          (echo.body as { headers: { "X-Synthetic-Token": string } }).headers["X-Synthetic-Token"],
          "synthetic-test-token",
        );
      },
    );

    test(
      "pins a secret revision while approval is pending",
      { timeout, skip: !adminToken && "set EGRESS_E2E_ADMIN_TOKEN" },
      async () => {
        const { id, pair } = await configured();
        await secret(id, "https://example.com", "synthetic-v1");
        await mount(
          id,
          'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { fetch(request) { return fetch(new Request("https://example.com/", { headers: { authorization: "{{secret:TEST_TOKEN}}", "x-project-core-approval": request.headers.get("x-project-core-approval") || "" } })) } }',
        );
        const first = pending((await external(id, "/pinned")).body);
        const changed = await secret(id, "https://example.com", "synthetic-v2");
        assert.equal(changed.status, 200, changed.text);
        await append(
          id,
          await approval(`${id}/`, "allow-pinned", first.requestId, first.fingerprint, true, pair),
        );
        const retry = await external(id, "/pinned", first.requestId);
        // Rotation changes the exact approved plan, so its old request id cannot reach injection.
        assertFault(retry, 409, "APPROVAL_MISMATCH");
        const events = await api(id, ["readEvents"], [{ afterOffset: 0, limit: 128 }]);
        assert.ok(!JSON.stringify(events).includes("itx.system.egress.released"));
      },
    );

    test("does not follow a permitted egress redirect", { timeout }, async () => {
      const { id } = await configured();
      await mount(
        id,
        'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { fetch() { return fetch(new Request("https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F", { redirect: "manual" })) } }',
        { approval: "none" },
      );
      const response = await external(id, "/redirect");
      assert.equal(response.status, 302, response.text);
      assert.equal(response.headers.get("location"), "https://example.com/");
    });

    test(
      "does not carry a same-origin secret placeholder across a followed redirect",
      { timeout, skip: !adminToken && "set EGRESS_E2E_ADMIN_TOKEN" },
      async () => {
        const { id } = await configured();
        await secret(id, "https://httpbin.org");
        await mount(
          id,
          'import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint { fetch() { return fetch(new Request("https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F", { headers: { "x-synthetic-token": "{{secret:TEST_TOKEN}}" } })) } }',
          { approval: "none" },
        );
        const response = await external(id, "/follow");
        assertFault(response, 403, "SECRET_ORIGIN");
        const page = (await api(id, ["readEvents"], [{ afterOffset: 0, limit: 128 }])) as {
          events: Array<{ type: string; data: { origin?: string } }>;
        };
        assert.ok(
          !page.events.some(
            (event) =>
              event.type === "itx.system.egress.released" &&
              event.data.origin === "https://example.com",
          ),
        );
      },
    );
  },
);
