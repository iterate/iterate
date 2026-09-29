// HTTP webhooks as a fan-out row's target; the fan-out semantics: src/stream/subscription-delivery.test.ts.
import { expect, test, vi } from "vitest";
import { ITERATE_CAUSE_HEADER } from "iterate/lib";
import {
  at,
  census,
  fakeDate,
  freshProject,
  interceptOrigins,
  readLog,
  rowOf,
  runOn,
  stub,
  totalCalls,
  until,
} from "./support.ts";

const HOOKS = "https://hooks.test";
/** A fan-out row `hook` POSTing every `test/order-placed` to HOOKS. */
const ROW = {
  name: "hook",
  target: ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], "deliverEvent"],
  delivery: "durable",
  consumes: ["test/order-placed"],
  ordered: false,
};

test("a webhook row POSTs each event signed from its context, at least once, and follows no redirect", async () => {
  const hooks = fakeReceiver((n) => (n % 3 ? 200 : n % 2 ? 500 : 307));
  const project = freshProject("prj_webhooks");
  const ctx = at(project, "/orders");
  await setSigningKey(project, "whsec_the-test-key", [HOOKS]);
  await configureHook(ctx, "/secrets/hook");
  const reads = await secretReadsOf(project);
  await stub(ctx).append(
    ...[1, 2, 3, 4, 5].map((n) => ({ type: "test/order-placed", payload: { n } })),
  );
  const ids = (await readLog(ctx))
    .filter(({ type }) => type === "test/order-placed")
    .map(({ offset }) => `${project}/orders@${offset}`);
  // a failed POST's retry is the ladder's first rung, 1 s later, and the second 2 s after that
  await until("every order acked", () => ids.every((id) => hooks.acked.has(id)), 20_000);
  // at least once: a repeat carries its first delivery's id
  expect(new Set(hooks.requests.map(({ id }) => id))).toEqual(new Set(ids));
  // the burst's POSTs share one read of the signing key
  expect((await secretReadsOf(project)) - reads).toBeLessThanOrEqual(2);
  for (const request of hooks.requests) {
    expect(request).toMatchObject({
      redirect: "manual",
      event: { type: "test/order-placed", path: "/orders" },
      signature: await signedWith("whsec_the-test-key", request),
    });
    // our mark, one hand-off deeper than the event: a receiver that feeds us back stops at the limit
    expect(JSON.parse(request.cause)).toMatchObject({ depth: 1 });
  }
});

test("a webhook that answers 410 Gone halts its row, the event still owed, until an operator's resume", async () => {
  let gone = true;
  const hooks = fakeReceiver(() => (gone ? 410 : 200));
  const ctx = at(freshProject("prj_webhooks"), "/orders");
  await configureHook(ctx);
  await stub(ctx).append({ type: "test/order-placed", payload: { n: 1 } });
  const halted = await until("the row halted", async () => (await rowOf(ctx, "hook"))?.halted);
  expect(halted.error).toContain("410");
  gone = false;
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "hook" },
  });
  await until("the owed event delivered", () => hooks.acked.size === 1);
  expect(hooks.requests.map(({ status }) => status)).toEqual([410, 200]);
});

test("a webhook row sends through its context's `itx.fetch`: in a child granted none, its event waits", async () => {
  const hooks = fakeReceiver(() => 200);
  const project = freshProject("prj_webhooks");
  await runOn(
    at(project, "/x"),
    `async (itx) => {
      const child = itx.cd("/x/hooks");
      await child.append({ type: "events.iterate.com/itx/subscription-configured", payload: ${JSON.stringify(ROW)} });
      await child.append({ type: "test/order-placed", payload: { n: 1 } });
    }`,
  );
  await until(
    "the event waits",
    async () => (await rowOf(at(project, "/x/hooks"), "hook"))?.pending === 1,
  );
  expect(hooks).toMatchObject({ requests: [] });
});

test("a webhook's signing key is read again after five seconds; a secret pinned elsewhere signs nothing", async () => {
  const start = fakeDate();
  const hooks = fakeReceiver(() => 200);
  const project = freshProject("prj_webhooks");
  const ctx = at(project, "/orders");
  await setSigningKey(project, "whsec_first", [HOOKS]);
  await configureHook(ctx, "/secrets/hook");
  const deliver = async (n: number) => {
    const before = hooks.requests.length;
    await stub(ctx).append({ type: "test/order-placed", payload: { n } });
    return until(`order ${n} posted`, () => hooks.requests[before]);
  };
  const first = await deliver(1);
  await setSigningKey(project, "whsec_second", [HOOKS]);
  vi.setSystemTime(start + 1_000); // inside the window: the key read at order 1 still signs
  const second = await deliver(2);
  vi.setSystemTime(start + 6_000); // past it: read again
  const third = await deliver(3);
  expect([first, second, third]).toMatchObject([
    { signature: await signedWith("whsec_first", first) },
    { signature: await signedWith("whsec_first", second) },
    { signature: await signedWith("whsec_second", third) },
  ]);
  await setSigningKey(project, "whsec_second", ["https://other.test"]);
  vi.setSystemTime(start + 12_000);
  await stub(ctx).append({ type: "test/order-placed", payload: { n: 4 } });
  await until("order 4 refused and pending", async () => (await rowOf(ctx, "hook"))?.pending === 1);
  expect(hooks.requests).toHaveLength(3);
});

/** `ctx`'s fan-out row `hook`, signed by `signingSecret` if given, sending through the project
 *  root's `fetch`, which a rule here grants. */
async function configureHook(ctx: string, signingSecret?: string) {
  await stub(ctx).append(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.fetch", target: "itx.builtins.cd('/').fetch" },
    },
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        ...ROW,
        target: ["itx", "webhooks", ["get", { url: `${HOOKS}/in`, signingSecret }], "deliverEvent"],
      },
    },
  );
}

/** The project's `/secrets/hook`, holding `key`, pinned to `urls`. */
function setSigningKey(project: string, key: string, urls: string[]) {
  return stub(project).invoke(["itx", "secrets", ["set", "/secrets/hook", key, { urls }]], [], {
    principal: null,
  });
}

/** How many calls the project's `/secrets/hook` has answered this incarnation. */
async function secretReadsOf(project: string) {
  return totalCalls(await census(at(project, "/secrets/hook")));
}

/** The signature header `request` carries when signed with `key`: HMAC-SHA256 over
 *  "<timestamp>.<body>", computed here with WebCrypto, not with the platform's helper. */
async function signedWith(key: string, request: { timestamp: string; body: string }) {
  const encode = (text: string) => new TextEncoder().encode(text);
  const hmac = { name: "HMAC", hash: "SHA-256" };
  const cryptoKey = await crypto.subtle.importKey("raw", encode(key), hmac, false, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encode(`${request.timestamp}.${request.body}`),
  );
  return `v1=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A receiver at HOOKS that answers its n-th request `answer(n)`: each request recorded, and
 *  `acked`, the id of every one answered 2xx. */
function fakeReceiver(answer: (n: number) => number) {
  const requests: {
    id: string;
    timestamp: string;
    signature: string;
    cause: string;
    body: string;
    event: unknown;
    redirect: string;
    status: number;
  }[] = [];
  const acked = new Set<string>();
  let n = 0;
  interceptOrigins({
    [HOOKS]: async (request) => {
      const status = answer(++n); // counted before the body is read, so in arrival order
      const header = (name: string) => request.headers.get(name) ?? "";
      const body = await request.text();
      const id = header("iterate-event-id");
      requests.push({
        id,
        timestamp: header("iterate-timestamp"),
        signature: header("iterate-signature"),
        cause: header(ITERATE_CAUSE_HEADER),
        body,
        event: JSON.parse(body),
        redirect: request.redirect,
        status,
      });
      if (status < 300) acked.add(id);
      return new Response(null, { status });
    },
  });
  return { requests, acked };
}
