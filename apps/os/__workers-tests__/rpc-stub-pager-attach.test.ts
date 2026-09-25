// __workers-tests__/rpc-stub-pager-attach.test.ts — THE ONE-SHOT PAGER ATTACH, inside workerd (the
// Workers suite — the only suite that can speak the DO's transport plumbing directly AND read its
// socket census, `rpcStubTransportState`).
//
// Target surface: RpcStubDirectory layer 2 (src/context/rpc-stubs.ts). The pager upgrade's
// `x-itx-rpc-stub-pager` header carries the KEY and the EVENTS THAT NAME IT; the DO accepts the
// socket and appends those events in the same turn — the SET half of "the DO owns both ends of a
// lent stub's rule" (the un-set half is the key's last pager close). So a `provide(stub)` is ONE
// edge→DO round trip. A refused append (a paused stream) is the upgrade's answer — a 409 whose JSON
// body carries the code — and leaves NO socket, NO presence and NO row: atomic, because accept and
// append share one synchronous turn. A malformed header is a 400.
//
// The UN-SET half, same layer: the key's last pager close appends the removal — refused under a
// pause, it lands on the `resumed` commit; a match at itx.builtins (the one row the removal spelling
// could never express) is refused AT APPEND, so no such row can ever sit beside the real ones. And
// a pager REPLACED at its key (a reconnect) is a reconnect, not a close: a page in flight survives
// the swap and the new pager's lend answers it.

import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { StreamEventInput } from "iterate/stream/processor";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import {
  encodeRpcStubPagerAttachRequest,
  ITX_EXPRESSION_FETCH_HEADER,
  RPC_STUB_PAGER_WEBSOCKET_HEADER,
} from "../src/context/rpc-stubs.ts";
import { adminCredentials, Echo, openSession, SRC_ECHO_APP, stub, until } from "./support.ts";

test("a malformed pager header is a 400; a well-formed one attaches the pager AND appends the rule that names its key — one request", async () => {
  const ctx = "prj_pager_attach";
  const malformed = await stub(ctx).fetch("https://rpc-stub-pager.internal/", {
    headers: { Upgrade: "websocket", [RPC_STUB_PAGER_WEBSOCKET_HEADER]: "never-an-attach-request" },
  });
  expect(malformed).toMatchObject({ status: 400 });
  expect(await malformed.text()).toContain("malformed x-itx-rpc-stub-pager header");
  expect(await transportState(ctx)).toMatchObject({ rpcStubPagers: 0 });

  const ok = await openPager(ctx, "itx.k1", [ruleFor("itx.k1")]);
  expect(ok).toMatchObject({ status: 101 });
  ok.webSocket!.accept();
  // The pager is attached, the key is present, and its rule exists — nothing else was called.
  expect(await transportState(ctx)).toMatchObject({ rpcStubPagers: 1 });
  expect(await presence(ctx)).toEqual(["itx.k1"]);
  expect(await ruleAt(ctx, "itx.k1")).toMatchObject({
    match: "itx.k1",
    target: "itx.rpcStubs.get('itx.k1')", // stored as the lender spelled it (it resolves through the implicit row)
    context: "/",
  });
  ok.webSocket!.close(1000, "test done");
});

test("a session's terminal fetch cannot smuggle a pager attach: its stamp (stampCallerHeaders) strips the DO's protocol headers, so the Request reaches the capability it names and appends nothing", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.get("prj_pager_smuggle");
  await itx.provide("itx.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const response: Response = await itx.echo.fetch(
    new Request("https://echo.internal/", {
      headers: {
        [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
          rpcStubKey: "itx.smuggled",
          appendEvents: [{ type: "smuggled" }],
        }),
      },
    }),
  );
  expect(response).toMatchObject({ status: 200 });
  expect(await response.json()).toMatchObject({ routingSlug: null });
  expect(await itx.rpcStubs.list()).not.toContain("itx.smuggled");
  const { events } = (await itx.invoke("itx.readEvents(0)")) as { events: { type: string }[] };
  expect(events.map((event) => event.type)).not.toContain("smuggled");
});

test("a platform-minted loaded worker's raw fetch cannot smuggle a pager attach either: ItxEntrypoint.fetch stamps the same way, though no app header closes the DO's pager gate for it", async () => {
  const ctx = "prj_pager_smuggle_platform";
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await itx.provide("itx.echo", ["itx", "workers", ["get", { source: SRC_ECHO_APP }]]);
  const response = await runInDurableObject(stub(ctx), async (_instance, state) => {
    const { exports } = state as unknown as {
      exports: {
        ItxEntrypoint(opts: {
          props: { iterateContextName: string; platformOrigin: null; platform: true };
        }): Fetcher;
      };
    };
    const loaded = exports.ItxEntrypoint({
      props: {
        iterateContextName: DurableObjectNameCodec.parse(ctx).name,
        platformOrigin: null,
        platform: true,
      },
    });
    const answer = await loaded.fetch(
      new Request("https://echo.internal/", {
        headers: {
          [ITX_EXPRESSION_FETCH_HEADER]: "itx.echo",
          [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
            rpcStubKey: "itx.smuggled",
            appendEvents: [{ type: "smuggled" }],
          }),
        },
      }),
    );
    return { status: answer.status, body: await answer.json() };
  });
  expect(response).toMatchObject({ status: 200, body: { routingSlug: null } });
  expect(await itx.rpcStubs.list()).not.toContain("itx.smuggled");
  const { events } = (await itx.invoke("itx.readEvents(0)")) as { events: { type: string }[] };
  expect(events.map((event) => event.type)).not.toContain("smuggled");
});

test("ATOMIC: a paused stream refuses the attach with 409 + code STREAM_PAUSED, and leaves no socket, no presence, no rule; after resume the same attach lands", async () => {
  const ctx = "prj_pager_attach_refused";
  const s = stub(ctx);
  await s.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });

  const refused = await openPager(ctx, "itx.k2", [ruleFor("itx.k2")]);
  expect(refused).toMatchObject({ status: 409 });
  expect(refused.webSocket).toBeNull();
  const body = (await refused.json()) as { code: string | null; message: string };
  expect(body).toMatchObject({ code: "STREAM_PAUSED" });
  expect(body.message).toContain("stream paused");
  // Nothing happened: accept and append share one synchronous turn, so a refusal un-accepts.
  expect(await transportState(ctx)).toMatchObject({ rpcStubPagers: 0 });
  expect(await presence(ctx)).toEqual([]);
  expect(await ruleAt(ctx, "itx.k2")).toBeNull();

  await s.append({ type: "events.iterate.com/itx/resumed" });
  const ok = await openPager(ctx, "itx.k2", [ruleFor("itx.k2")]);
  expect(ok).toMatchObject({ status: 101 });
  ok.webSocket!.accept();
  expect(await transportState(ctx)).toMatchObject({ rpcStubPagers: 1 });
  expect(await presence(ctx)).toEqual(["itx.k2"]);
  expect((await ruleAt(ctx, "itx.k2"))?.target).toBe("itx.rpcStubs.get('itx.k2')");
  ok.webSocket!.close(1000, "test done");
});

test("HAPPY PATH: provide over /api opens the pager (the rule riding it); a separate caller's invoke pages, borrows and answers", async () => {
  const ctx = "prj_pager_happy";
  const clientItx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  await clientItx.provide("itx.live", new Echo(7));
  const caller = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  const out = await caller.invoke("itx.live.echo('hi')");
  expect(out).toBe("echo-7:hi");
});

// ── the un-set half: the key's LAST pager close ──

test("a stub whose last pager closes DURING a pause keeps its rule (the un-set append is refused) and is un-set once the stream resumes", async () => {
  const ctx = "prj_pager_pause_unset";
  const s = stub(ctx);
  const pager = await openPager(ctx, "itx.k5", [ruleFor("itx.k5")]);
  expect(pager).toMatchObject({ status: 101 });
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/itx/paused", payload: { reason: "test" } });
  pager.webSocket!.close(1000, "session died while paused");
  await until("the pager is gone", async () => (await transportState(ctx)).rpcStubPagers === 0);
  // the un-set was refused by the pause: the row stands (the window)
  expect((await ruleAt(ctx, "itx.k5"))?.target).toBe("itx.rpcStubs.get('itx.k5')");

  await s.append({ type: "events.iterate.com/itx/resumed" });
  await until("the rule un-set after resume", async () => (await ruleAt(ctx, "itx.k5")) === null);
});

test("append REFUSES a rule match rooted at itx.builtins (the reserved fixed point is no rule's to claim) — the un-expressible row can never enter the log beside the real ones", async () => {
  const ctx = "prj_pager_raw_builtins_row";
  // The DO validates every append: a match at itx.builtins — the fixed point every call rewrites
  // TO — is refused, so the "raw row the removal spelling cannot express" can never enter the log to
  // begin with (a raw append once bypassed the builder; the boundary is append itself now).
  await runInDurableObject(stub(ctx), async (instance) => {
    await expect(
      instance.append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.builtins.foo", target: "itx.builtins.rpcStubs.get('itx.k7')" },
      }),
    ).rejects.toThrow(/itx\.builtins/);
  });
  // and a real rule's own un-set sweep is untouched: the pager's last close un-sets itx.k7's row.
  const pager = await openPager(ctx, "itx.k7", [ruleFor("itx.k7")]);
  expect(pager).toMatchObject({ status: 101 });
  pager.webSocket!.accept();
  expect((await ruleAt(ctx, "itx.k7"))?.target).toBe("itx.rpcStubs.get('itx.k7')");
  pager.webSocket!.close(1000, "last pager");
  await until("itx.k7's own rule is un-set", async () => (await ruleAt(ctx, "itx.k7")) === null);
});

// ── a replaced pager is a reconnect, not a close ──

test("a pager RECONNECT while a page is in flight is a reconnect, not a close: the page (per KEY, not per socket) survives the swap and the new pager's lend answers it", async () => {
  const ctx = "prj_pager_reconnect_midpage";
  const s = stub(ctx);
  const rpcStubKey = "itx.reconnecting";

  // Pager #1 is attached but DELIBERATELY never answers — the relay whose isolate is on its way
  // out, the one a client reconnects to replace.
  let pagesSeenByFirstPager = 0;
  const first = await openPager(ctx, rpcStubKey);
  first.webSocket!.accept();
  first.webSocket!.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"')) pagesSeenByFirstPager++;
  });

  // A cold call on the key: nothing borrowed, so the DO pages and waits.
  const call = s.invoke([
    "itx",
    "rpcStubs",
    ["get", rpcStubKey],
    ["echo", "hi"],
  ]) as Promise<unknown>;
  call.catch(() => undefined); // settled by the assertion below, never an unhandled rejection
  await until("the page reached pager #1", () => pagesSeenByFirstPager > 0);
  expect(await transportState(ctx)).toMatchObject({ rpcStubPagesInFlight: 1 });

  // THE RECONNECT: the client re-provides at the same key from a fresh relay. Its pager attaches
  // (the DO drops pager #1 as "replaced") and it answers pages with a lend, like any relay.
  const second = await openPager(ctx, rpcStubKey);
  second.webSocket!.accept();
  second.webSocket!.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string" && event.data.includes('"page"'))
      void s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });
  });
  await s.lendRpcStub({ rpcStubKey, stub: new LentAnswer("reconnected") as never });

  try {
    // The stub is right there under the key — the waiting call is served, not refused.
    await expect(call).resolves.toContain("reconnected");
  } finally {
    first.webSocket!.close(1000, "test done");
    second.webSocket!.close(1000, "test done");
  }
});

/** Open a pager upgrade straight at the DO's `fetch` (what lendRpcStubOverPager does relay-side):
 *  the header IS the attach request — the key and the events that name it. */
function openPager(ctx: string, rpcStubKey: string, appendEvents: StreamEventInput[] = []) {
  return stub(ctx).fetch("https://rpc-stub-pager.internal/", {
    headers: {
      Upgrade: "websocket",
      [RPC_STUB_PAGER_WEBSOCKET_HEADER]: encodeRpcStubPagerAttachRequest({
        rpcStubKey,
        appendEvents,
      }),
    },
  });
}

function ruleFor(rpcStubKey: string): StreamEventInput {
  return {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: rpcStubKey, target: ["itx", "rpcStubs", ["get", rpcStubKey]] },
  };
}

async function transportState(ctx: string) {
  return (await stub(ctx).rpcStubTransportState()) as unknown as {
    rpcStubPagers: number;
    rpcStubPagesInFlight: number;
  };
}

function presence(ctx: string) {
  return stub(ctx).invoke(["itx", "rpcStubs", ["list"]]) as Promise<string[]>;
}

function ruleAt(ctx: string, match: string) {
  return stub(ctx).invoke(["itx", "rewriteRules", ["get", match]]) as Promise<{
    target: string;
  } | null>;
}

/** What a relay lends: the `invoke(steps)` half of a BorrowedRpcStub, tagged. */
class LentAnswer extends RpcTarget {
  readonly #tag: string;
  constructor(tag: string) {
    super();
    this.#tag = tag;
  }
  async invoke(itxExpressionSteps: unknown[]): Promise<string> {
    return `${this.#tag}:${JSON.stringify(itxExpressionSteps)}`;
  }
}
