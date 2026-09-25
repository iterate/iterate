// for-caller.e2e.test.ts — A LOADED FACET SERVES A CALLER BENEATH ITS HOST ONLY AS THAT CALLER
// (context/caller-capability.ts). H hosts the facet; O is the context the call originated at, the
// origin the platform stamped at the call's first hop, or H itself. A facet whose class lists
// `forCaller`:
//   • from O at H or above it, answers as its host: the caller already holds H;
//   • from O strictly beneath H, is called `forCaller(caller)` first and the caller's steps walk what
//     it answers — `caller` is `{ path: O, itx }`, O's own app handle, walled at O (its `cd` goes
//     down only) and resolved through O's table;
//   • from O beside H, answers as its host, handing over nothing: O's code never chose it;
//   • never runs a `forCaller` a caller spelled: only the platform names a caller.
// A facet that lists no `forCaller` is called as its host from anywhere. Beside it: a loaded facet
// is told its own spec (`ctx.props.spec`, its startup memo), and a stateless worker walks a chained
// call the way a facet does.
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

/** A facet that serves callers beneath its host: what `forCaller` answers acts only through the
 *  caller's handle; the facet's own methods act through its host's `env.ITX`. */
const SERVING = {
  source: {
    "worker.js": `import { RpcTarget } from "cloudflare:workers";
import { FacetDurableObject, withItx } from "iterate/sdk";
const outcome = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: String(e?.message ?? e) }; } };
class Served extends RpcTarget {
  #caller;
  constructor(caller) { super(); this.#caller = caller; }
  path() { return this.#caller.path; }
  whoami() { return withItx(this.#caller.itx, (itx) => itx.whoami()); }
  up() { return outcome(() => withItx(this.#caller.itx, (itx) => itx.cd("/").whoami())); }
}
export class ServingDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "forCaller", "path", "whoami", "up", "spec"];
  forCaller(caller) { return new Served(caller); }
  path() { return "the host"; }
  whoami() { return withItx(this.env.ITX, (itx) => itx.whoami()); }
  spec() { return this.ctx.props.spec ?? null; }
}
export class HostOnlyDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "whoami"];
  whoami() { return withItx(this.env.ITX, (itx) => itx.whoami()); }
}`,
  },
  className: "ServingDurableObject",
};

test("a facet that lists forCaller serves a caller beneath its host as that caller: forCaller(caller) first, the caller's own handle walled at the caller", async () => {
  const { ctx, root, jail } = await servedAtTheRoot("for-caller-beneath");
  expect(await root.serving.path()).toBe("the host");
  expect(await root.serving.whoami()).toEqual({ projectId: ctx, path: "/" });
  expect(
    await jail.serving.path(),
    "a caller beneath the host should be served through forCaller",
  ).toBe("/jail");
  // Loaded code at /jail, through its link: the same caller, and the handle it is served through
  // is its own — walled at /jail, so a `cd` above it is refused.
  expect(
    await jail.builtins.run(`async (itx) => ({
        path: await itx.serving.path(),
        whoami: await itx.serving.whoami(),
        up: await itx.serving.up(),
      })`),
  ).toEqual({
    path: "/jail",
    whoami: { projectId: ctx, path: "/jail" },
    up: { error: expect.stringMatching(/goes down only/) },
  });
});

test("a walk that spells forCaller is FORBIDDEN: only the platform names a caller", async () => {
  const { root, jail } = await servedAtTheRoot("for-caller-forged");
  for (const [from, context] of [
    ["/", root],
    ["/jail", jail],
  ] as const)
    expect(
      await outcomeOf(context.invoke("itx.serving.forCaller({ path: '/elsewhere' }).path()")),
      `only the platform should name a caller (from ${from})`,
    ).toEqual({ error: expect.stringMatching(/"forCaller" is the platform's/) });
});

test("a facet that lists forCaller answers a caller above its host, and a caller beside it, as its host", async () => {
  const root = openItx(freshCtx("for-caller-beside"));
  const atMid = (steps: unknown[]) => ["itx", ["cd", "/mid"], "facets", ...steps];
  expect(await root.invoke(atMid([["get", "serving", SERVING], ["path"]]))).toBe("the host");
  expect(
    await outcomeOf(root.cd("/other").invoke(atMid([["get", "serving"], ["path"]]))),
    "a caller beside the host should be served as the host, handed nothing",
  ).toEqual({ answer: "the host" });
});

/** A worker that serves callers: `forCaller` answers an object acting through the caller's handle. */
const SERVING_WORKER = {
  "worker.js": `import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
class Served extends RpcTarget {
  #caller;
  constructor(caller) { super(); this.#caller = caller; }
  whoami() { return withItx(this.#caller.itx, (itx) => itx.whoami()); }
}
export default class Serving extends WorkerEntrypoint {
  forCaller(caller) { return new Served(caller); }
  whoami() { return withItx(this.env.ITX, (itx) => itx.whoami()); }
}`,
};

test("a worker whose spec says servesCallers serves a caller beneath its host as that caller; a spec that does not, and a caller beside it, as its host; only the platform names a caller", async () => {
  const ctx = freshCtx("for-caller-worker");
  const root = openItx(ctx);
  for (const [match, servesCallers] of [
    ["itx.served", true],
    ["itx.hosted", false],
  ] as const)
    await root.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match,
        target: [
          "itx",
          "workers",
          ["get", { source: SERVING_WORKER, ...(servesCallers && { servesCallers }) }],
        ],
      },
    });
  const jail = root.cd("/jail");
  await jail.provide("itx", "itx.builtins.cd('/')");
  expect(await jail.served.whoami()).toEqual({ projectId: ctx, path: "/jail" });
  expect(await jail.hosted.whoami()).toEqual({ projectId: ctx, path: "/" });
  expect(await root.served.whoami()).toEqual({ projectId: ctx, path: "/" });
  expect(
    await outcomeOf(jail.invoke("itx.served.forCaller({ path: '/elsewhere' }).whoami()")),
  ).toEqual({ error: expect.stringMatching(/"forCaller" is the platform's/) });
});

test("a facet that lists no forCaller is called as its host from anywhere", async () => {
  const { ctx, root, jail } = await servedAtTheRoot("for-caller-none");
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.hostOnly",
      target: [
        "itx",
        "facets",
        ["get", "host-only", { ...SERVING, className: "HostOnlyDurableObject" }],
      ],
    },
  });
  expect(await jail.hostOnly.whoami()).toEqual({ projectId: ctx, path: "/" });
});

test("a loaded facet is told its own spec: ctx.props.spec is its startup memo", async () => {
  const root = openItx(freshCtx("facet-spec"));
  expect(
    await root.facets.get("serving", SERVING).spec(),
    "a loaded facet should be told its own spec",
  ).toEqual(SERVING);
  const keyed = { ...SERVING, cacheKey: "serving@v1" };
  expect(await root.facets.get("keyed", keyed).spec()).toEqual(keyed);
});

/** A worker whose method answers a live object: a chained walk calls on through it. */
const MAKER = {
  "worker.js": `import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
class Made extends RpcTarget {
  constructor(n) { super(); this.n = n; }
  ping() { return "pong-" + this.n; }
}
export default class Maker extends WorkerEntrypoint { make(n) { return new Made(n); } }`,
};

test("a stateless worker walks a chained call as a facet does: each step on what the one before answered", async () => {
  const root = openItx(freshCtx("worker-chain"));
  // The handle's own `invoke` hands it the whole walk at once.
  expect(
    await root.invoke([
      "itx",
      "workers",
      ["get", { source: MAKER }],
      ["invoke", [["make", 7], ["ping"]]],
    ]),
  ).toBe("pong-7");
});

/** `/` hosts SERVING behind `itx.serving`, and `/jail` is linked to `/`: its unclaimed names answer
 *  there, as a workspace's or an agent's do. */
async function servedAtTheRoot(prefix: string) {
  const ctx = freshCtx(prefix);
  const root = openItx(ctx);
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.serving", target: ["itx", "facets", ["get", "serving", SERVING]] },
  });
  const jail = root.cd("/jail");
  await jail.provide("itx", "itx.builtins.cd('/')");
  return { ctx, root, jail };
}

const outcomeOf = (call: Promise<unknown>) =>
  call.then(
    (answer) => ({ answer }),
    (error: Error) => ({ error: error.message }),
  );
