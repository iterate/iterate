// __workers-tests__/webhooks.test.ts — HTTP WEBHOOKS as a fan-out row's target
// (`itx.webhooks.get({ url, signingSecret? }).deliverEvent`, src/context/built-ins.ts): each event
// POSTed as JSON from the context it happened in, through that context's own `itx.fetch` (nothing
// where it may not fetch), to a local fake that answers every third request 500 — every event
// arrives at least once, its repeats carry the same `iterate-event-id`, a failing one holds up none
// of the others, every signature verifies (checked by an HMAC written here, not the platform's), and
// the signing key is read from its secret once per five seconds: a rotation signs with the new key
// after that, and a secret no longer pinned to the receiver's origin signs nothing. A redirect is an
// answer, never followed; a 410 halts the row until an operator's resume. The fan-out semantics:
// src/stream/subscription-delivery.test.ts.
import { expect, test, vi } from "vitest";
import { readLog, runOn, stub, until } from "./support.ts";

const HOOKS = "https://hooks.test";
/** Another origin, which a redirect names. */
const ELSEWHERE = "https://elsewhere.test";
const SIGNING_KEY = "whsec_the-test-key";
/** A fan-out row `hook` POSTing every `test/order-placed` to HOOKS. */
const ROW = {
  name: "hook",
  target: ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], "deliverEvent"],
  consumes: ["test/order-placed"],
  ordered: false,
};

test("a webhook row POSTs every event, signed, from its context: a receiver failing every third request still gets each event, repeats share their id, and the failures hold up no other event", async () => {
  const hooks = fakeReceiver({ answer: (n) => (n % 3 === 0 ? 500 : 200) });
  const project = `prj_webhooks_${crypto.randomUUID().slice(0, 8)}`;
  const ctx = `${project}.iterate/orders`;
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/hook", SIGNING_KEY, { urls: [HOOKS] }]],
    [],
    { principal: null },
  );
  const secretReads = await secretReadsOf(project);
  await configureHook(ctx, { url: `${HOOKS}/in`, signingSecret: "/secrets/hook" });
  const placed = [];
  for (let n = 1; n <= 9; n++)
    placed.push(
      ...((await stub(ctx).append({ type: "test/order-placed", payload: { n } })) as unknown as {
        offset: number;
      }[]),
    );
  const ids = placed.map(({ offset }) => `${project}/orders@${offset}`);

  await until(
    "every order acked",
    () => ids.every((id) => hooks.acked.has(id)) || undefined,
    20_000, // a failed POST's retry is the ladder's first rung, 1 s later
  );
  // at least once, some twice: every id acked, and a repeat carries its first delivery's id
  expect([...hooks.acked].sort()).toEqual([...ids].sort());
  expect(hooks.requests.length).toBeGreaterThan(ids.length);
  expect(new Set(hooks.requests.map((request) => request.id))).toEqual(new Set(ids));
  // the body is the event, the signature its HMAC over "<timestamp>.<body>" with the key
  for (const request of hooks.requests) {
    expect(JSON.parse(request.body)).toMatchObject({ type: "test/order-placed", path: "/orders" });
    expect(request).toMatchObject({
      signature: `v1=${await hmacHex(SIGNING_KEY, `${request.timestamp}.${request.body}`)}`,
    });
  }
  // a failure held up nothing: an event after the first failed one was acked before that
  // failed event's retry reached the receiver
  const firstFailed = hooks.requests.find((request) => request.status === 500)!;
  const retry = hooks.requests.findIndex(
    (request, index) =>
      request.id === firstFailed.id && index > hooks.requests.indexOf(firstFailed),
  );
  expect(
    hooks.requests
      .slice(hooks.requests.indexOf(firstFailed) + 1, retry)
      .some((request) => request.status === 200),
  ).toBe(true);
  // the key was read from its secret once for the burst, not once per POST
  expect((await secretReadsOf(project)) - secretReads).toBeLessThanOrEqual(2);
  expect(await readLog(ctx)).not.toContainEqual(
    expect.objectContaining({ type: "events.iterate.com/itx/subscription-delivery-failed" }),
  );
});

test("a webhook that answers 410 Gone halts its row — the event stays owed — and an operator's resume reopens it", async () => {
  let gone = true;
  const hooks = fakeReceiver({ answer: () => (gone ? 410 : 200) });
  const project = `prj_webhooks_${crypto.randomUUID().slice(0, 8)}`;
  const ctx = `${project}.iterate/orders`;
  await configureHook(ctx, { url: `${HOOKS}/in` });
  const [placed] = (await stub(ctx).append({
    type: "test/order-placed",
    payload: { n: 1 },
  })) as unknown as { offset: number }[];
  const halted = await until("the row halted", async () => {
    const row = (await stub(ctx).invoke("itx.subscriptions.get('hook')")) as {
      halted?: { error?: string };
    };
    return row.halted;
  });
  expect(halted.error).toContain("410");
  expect(hooks.requests.map((request) => request.status)).toEqual([410]);
  gone = false;
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "hook" },
  });
  await until(
    "the owed event delivered",
    () => hooks.acked.has(`${project}/orders@${placed!.offset}`) || undefined,
  );
  expect(hooks.requests.map((request) => request.status)).toEqual([410, 200]);
});

test("a webhook row sends through its context's own `itx.fetch`: where that context may not fetch — /orders with no fetch row, or a child loaded code configured a row in — the event waits and nothing is sent", async () => {
  const hooks = fakeReceiver({ answer: () => 200 });
  const project = `prj_webhooks_${crypto.randomUUID().slice(0, 8)}`;
  const orders = `${project}.iterate/orders`;
  await stub(orders).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: ROW,
  });
  await stub(orders).append({ type: "test/order-placed", payload: { n: 1 } });
  await runOn(
    `${project}.iterate/x`,
    `async (itx) => {
      const child = itx.cd("/x/hooks");
      await child.append({ type: "events.iterate.com/itx/subscription-configured", payload: ${JSON.stringify(ROW)} });
      await child.append({ type: "test/order-placed", payload: { n: 2 } });
    }`,
  );
  for (const ctx of [orders, `${project}.iterate/x/hooks`])
    await until(`${ctx}'s event waits`, async () => {
      const view = (await stub(ctx).invoke("itx.subscriptions.get('hook')")) as {
        pending?: number;
      };
      return view.pending === 1 || undefined;
    });
  expect(hooks).toMatchObject({ requests: [] });
});

test("a webhook's redirect is an answer, never followed: a signed POST answered 307 to another origin sends that origin nothing — not the event, not its signature — and the event is retried at the receiver, never acked", async () => {
  const hooks = fakeReceiver({ answer: () => 307 });
  const project = `prj_webhooks_${crypto.randomUUID().slice(0, 8)}`;
  const ctx = `${project}.iterate/orders`;
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/hook", SIGNING_KEY, { urls: [HOOKS] }]],
    [],
    { principal: null },
  );
  await configureHook(ctx, { url: `${HOOKS}/in`, signingSecret: "/secrets/hook" });
  await stub(ctx).append({ type: "test/order-placed", payload: { n: 1 } });
  await until(
    "the event retried",
    () => (hooks.requests.length > 1 ? true : undefined),
    20_000, // the retry is the ladder's first rung, 1 s later
  );
  expect(hooks.requests.slice(0, 2)).toMatchObject([
    { status: 307, signature: expect.stringMatching(/^v1=/) },
    { status: 307, signature: expect.stringMatching(/^v1=/) },
  ]);
  expect(hooks).toMatchObject({ elsewhere: [], acked: new Set() });
});

test("a webhook's signing key is read again after five seconds: a rotated key signs from then on, and a secret no longer pinned to the receiver's origin signs nothing", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const hooks = fakeReceiver({ answer: () => 200 });
    const project = `prj_webhooks_${crypto.randomUUID().slice(0, 8)}`;
    const ctx = `${project}.iterate/orders`;
    const setKey = (key: string, urls: string[]) =>
      stub(project).invoke(["itx", "secrets", ["set", "/secrets/hook", key, { urls }]], [], {
        principal: null,
      });
    await setKey("whsec_first", [HOOKS]);
    await configureHook(ctx, { url: `${HOOKS}/in`, signingSecret: "/secrets/hook" });
    const deliver = async (n: number) => {
      const before = hooks.requests.length;
      await stub(ctx).append({ type: "test/order-placed", payload: { n } });
      return until(`order ${n} posted`, () => hooks.requests[before]);
    };
    const signedWith = async (key: string, request: { timestamp: string; body: string }) =>
      `v1=${await hmacHex(key, `${request.timestamp}.${request.body}`)}`;

    const first = await deliver(1);
    expect(first).toMatchObject({ signature: await signedWith("whsec_first", first) });
    await setKey("whsec_second", [HOOKS]);
    vi.setSystemTime(start + 1_000); // inside the window: the key read at order 1 still signs
    const second = await deliver(2);
    expect(second).toMatchObject({ signature: await signedWith("whsec_first", second) });
    vi.setSystemTime(start + 6_000); // past it: read again
    const third = await deliver(3);
    expect(third).toMatchObject({ signature: await signedWith("whsec_second", third) });

    // REVOKED for this origin: the secret now pinned elsewhere signs no request to the receiver
    await setKey("whsec_second", ["https://other.test"]);
    vi.setSystemTime(start + 12_000);
    const [fourth] = (await stub(ctx).append({
      type: "test/order-placed",
      payload: { n: 4 },
    })) as unknown as { offset: number }[];
    const pending = await until("order 4 refused and pending", async () => {
      const view = (await stub(ctx).invoke("itx.subscriptions.get('hook')")) as {
        pending?: number;
      };
      return view.pending === 1 ? view : undefined;
    });
    expect(pending).toMatchObject({ pending: 1 });
    expect(hooks.requests.filter(({ id }) => id === `${project}/orders@${fourth!.offset}`)).toEqual(
      [],
    );
  } finally {
    vi.useRealTimers();
  }
});

/** `ctx`'s fan-out row `hook`: every `test/order-placed` POSTed to `spec`'s webhook, through the
 *  project root's `fetch`, which a rule here grants. */
async function configureHook(ctx: string, spec: { url: string; signingSecret?: string }) {
  await stub(ctx).append(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.fetch", target: "itx.builtins.cd('/').fetch" },
    },
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: { ...ROW, target: ["itx", "webhooks", ["get", spec], "deliverEvent"] },
    },
  );
}

/** HMAC-SHA256 of `message` under `key`, lowercase hex — written here with WebCrypto, so a
 *  signature is checked against the algorithm the header names, not the platform's own helper. */
async function hmacHex(key: string, message: string) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A receiver at HOOKS, faked in this isolate's `fetch`: each POST recorded — its event id,
 *  timestamp, signature, body and the status it was answered — and answered `answer(n)` for the
 *  n-th request; `acked` holds every event id answered 2xx. */
function fakeReceiver({ answer }: { answer: (n: number) => number }) {
  const requests: {
    id: string;
    timestamp: string;
    signature: string;
    body: string;
    status: number;
  }[] = [];
  const acked = new Set<string>();
  /** Every request that reached ELSEWHERE: its body and any signature it carried. */
  const elsewhere: { body: string; signature: string | null }[] = [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === ELSEWHERE) {
      elsewhere.push({
        body: await request.text(),
        signature: request.headers.get("iterate-signature"),
      });
      return new Response(null, { status: 200 });
    }
    if (new URL(request.url).origin !== HOOKS) return through(request);
    const status = answer(requests.length + 1);
    const id = request.headers.get("iterate-event-id") ?? "";
    const body = await request.text();
    requests.push({
      id,
      timestamp: request.headers.get("iterate-timestamp") ?? "",
      signature: request.headers.get("iterate-signature") ?? "",
      body,
      status,
    });
    if (status < 300) acked.add(id);
    if (status >= 300 && status < 400) {
      const redirect = new Response(null, { status, headers: { location: `${ELSEWHERE}/in` } });
      // what fetch itself does with a 307 unless the request asked for `manual`: send it again there
      return request.redirect === "manual"
        ? redirect
        : globalThis.fetch(
            new Request(`${ELSEWHERE}/in`, { method: "POST", headers: request.headers, body }),
          );
    }
    return new Response(null, { status });
  });
  return { requests, acked, elsewhere };
}

/** How many calls the project's `/secrets/hook` context has answered this incarnation: its own
 *  census (context/residency.ts). */
async function secretReadsOf(project: string) {
  const { calls } = await stub(`${project}.iterate/secrets/hook`).inboundCallCensus();
  return calls.loaded + calls.context + calls.other;
}
