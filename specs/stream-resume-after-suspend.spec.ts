import { expect, type Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { test } from "./test-support/test.ts";

// Regression suite for the "stream feed wedges after browser suspend" bug:
// the stream view's runtime factory used to close over the itx capnweb handle
// captured at mount (project-stream-view.tsx), acquireStreamRuntime deduped by
// (projectId, streamPath) and ignored fresh factories on re-acquire
// (stream-browser-store.ts), so once the /api WebSocket died the runtime's
// reconnect loop kept dialing through the dead capnweb session forever. The
// itx socket map itself re-dialed fine — only the stream runtimes stayed
// wedged until a full page reload. The fix: per-call transport resolution in
// the view's source, factory refresh on re-acquire, a dial deadline, and
// resetTransport eviction for the half-open lane.
//
// Assertions ride window.__streamRuntimeDebug() (stream-browser-store.ts's
// debug registry) — transport-level truth, immune to UI-layer noise.

const MARKER_EVENT_TYPE = "events.iterate.test/spec/suspend-marker";
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";
// This is the failure stimulus, not a recovery budget. The test arms an
// in-page timer immediately before CDP suspends script execution and verifies
// its gap after resume. Socket death is modeled explicitly, so the stimulus
// need not wait for the OS to reap a connection during a guessed long window.
const SUSPEND_STIMULUS_MS = 2_000;
const SUSPEND_EVIDENCE_MIN_GAP_MS = 1_500;

type SuspendTimerEvidence = {
  maxTimerGapMs: number;
};

// Fresh streams' first post-subscribe delivery can stall and needs the ~10s
// probe self-heal (see reactivity.spec.ts's DELIVERY_WAIT rationale), so the
// healthy-path window is 30s, not the theoretical "instant".
const HEALTHY_DELIVERY_MS = 30_000;
// Post-death recovery window. Worst case is the half-open lane: up to two
// probe intervals + two 10s probe timeouts to declare the transport suspect,
// then resetTransport + a fresh dial + election + subscribe — measured ~40-56s
// locally, so 90s leaves headroom for slower preview CI boxes without hiding
// a real wedge (the wedge is permanent; any finite window catches it).
const RECOVERY_DELIVERY_MS = 90_000;

test("control: appended event is delivered to a live stream feed", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("suspend-control");
  const consoleLines = captureStreamConsole(page);

  const agent = await fixture.createAgent();

  await page.goto(agent.webUrl);
  const keys = runtimeDebugKeys(fixture.project.id, agent.path);
  await waitForSubscribed(page, keys);

  const [marker] = await agent.stream.append({
    type: MARKER_EVENT_TYPE,
    payload: { marker: "control" },
  });
  const { delivered, snapshot } = await pollDelivered(
    page,
    keys,
    marker!.offset,
    HEALTHY_DELIVERY_MS,
  );
  dumpEvidence("control", snapshot, consoleLines);
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- deliberate suspend-repro probe: pollDelivered() never throws so the evidence dump above always runs; the boolean verdict is asserted here with the diagnostic message.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered to a healthy subscription`,
  ).toBe(true);
});

test("feed resumes after the /api WebSocket dies (clean close)", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("suspend-socket");
  await installSocketKillSwitch(page);
  const consoleLines = captureStreamConsole(page);

  const agent = await fixture.createAgent();

  await page.goto(agent.webUrl);
  const keys = runtimeDebugKeys(fixture.project.id, agent.path);
  await waitForSubscribed(page, keys);

  // Kill the itx transport from inside the page — the "close event delivered"
  // lane (mobile Safari suspend, proxy idle timeout, …). The itx socket map
  // drops its entry; the runtimes' per-call source must reach the fresh dial.
  const closed = await page.evaluate(() =>
    (window as unknown as { __closeAllApiSockets: () => string[] }).__closeAllApiSockets(),
  );
  console.log(`closed sockets: ${JSON.stringify(closed)}`);
  expect(closed.length, "expected at least one live /api WebSocket to close").toBeGreaterThan(0);

  // Append immediately: delivery is the recovery invariant, so polling it
  // covers however many liveness-probe intervals the runtime actually needs
  // without paying a guessed probe delay before starting the real assertion.
  const [marker] = await test.step("clean close: append recovery marker", () =>
    agent.stream.append({
      type: MARKER_EVENT_TYPE,
      payload: { marker: "after-socket-death" },
    }));
  const { delivered, snapshot } =
    await test.step("clean close: redial and deliver a new stream event", () =>
      pollDelivered(page, keys, marker!.offset, RECOVERY_DELIVERY_MS));
  dumpEvidence("after socket death", snapshot, consoleLines);
  // The historical wedge: runtimes stuck in connectionStatus "reconnecting"
  // with connectionError "connect failed: Peer closed WebSocket: 1005"
  // forever, dialing through the dead mount-time capnweb session.
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- deliberate suspend-repro probe: pollDelivered() never throws so the evidence dump above always runs; the boolean verdict is asserted here with the diagnostic message.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the browser re-dials /api — see the __streamRuntimeDebug dump above for the reconnect wedge`,
  ).toBe(true);
});

test("feed resumes after page freeze + socket death (mobile suspend shape)", async ({
  helpers,
  page,
}) => {
  await using fixture = await helpers.createFixture("suspend-freeze");
  await installSocketKillSwitch(page);
  await installSuspendTimerProbe(page);
  const consoleLines = captureStreamConsole(page);

  const agent = await fixture.createAgent();

  await page.goto(agent.webUrl);
  const keys = runtimeDebugKeys(fixture.project.id, agent.path);
  await waitForSubscribed(page, keys);

  // Mobile suspend ≈ suspended page script + the OS reaping the TCP
  // connection. This lane covers the close-event-delivered shape; the dedicated
  // half-open test below covers a death with no close frame and pays the real
  // two-strike liveness windows. Wait for the ORIGINAL socket's close event
  // before freezing so this case does not accidentally duplicate that slower
  // half-open lane merely because CDP disabled script before the event arrived.
  const cdp = await page.context().newCDPSession(page);
  const closed = await test.step("observe socket death before suspending page script", () =>
    page.evaluate(() =>
      (
        window as unknown as { __closeAllApiSocketsAndWait: () => Promise<string[]> }
      ).__closeAllApiSocketsAndWait(),
    ));
  console.log(`closed sockets: ${JSON.stringify(closed)}`);
  expect(closed.length, "expected at least one live /api WebSocket to close").toBeGreaterThan(0);
  await test.step("suspend page script, drop network, and resume", async () => {
    await page.context().setOffline(true);
    await page.evaluate(() =>
      (window as unknown as { __armSuspendTimerProbe: () => void }).__armSuspendTimerProbe(),
    );
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
    // This sleep IS the suspend stimulus: wall-clock passing while the page
    // is frozen (scripts disabled), so there is no UI to wait on.
    // timeout: the stimulus itself — nothing for the spinner-waiter here
    await page.waitForTimeout(SUSPEND_STIMULUS_MS);
    await page.context().setOffline(false);
    await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
    await expect
      .poll(async () => (await readSuspendTimerEvidence(page)).maxTimerGapMs, {
        message: "the armed page timer should remain suspended for the stimulus window",
        // timeout: poll budget — expect.poll is outside the spinner-waiter's reach
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(SUSPEND_EVIDENCE_MIN_GAP_MS);
    const retiredTransitionDials = await page.evaluate(() => {
      const closed = (
        window as unknown as { __closeAllApiSockets: () => string[] }
      ).__closeAllApiSockets();
      // Chromium does not reliably revive a WebSocket whose constructor ran
      // while offline. Retire every transition dial after connectivity is
      // restored, then give the runtime the real returning-browser signal so
      // its next constructor starts online.
      window.dispatchEvent(new Event("online"));
      return closed;
    });
    console.log(`retired transition sockets: ${JSON.stringify(retiredTransitionDials)}`);
  });

  // Going back online lets the runtime's resume check fire; its periodic probe
  // remains the fallback.
  // Append immediately and wait on durable delivery so
  // a healthy runtime finishes when it heals, while the historical permanent
  // wedge still consumes the full bounded recovery window and fails.
  const [marker] = await test.step("thaw: append recovery marker", () =>
    agent.stream.append({
      type: MARKER_EVENT_TYPE,
      payload: { marker: "after-freeze" },
    }));
  const { delivered, snapshot } =
    await test.step("thaw: redial and deliver a new stream event", () =>
      pollDelivered(page, keys, marker!.offset, RECOVERY_DELIVERY_MS));
  dumpEvidence("after freeze", snapshot, consoleLines);
  // Historically the same wedge as the clean-close test — the frozen window
  // only delayed when the liveness probe noticed.
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- deliberate suspend-repro probe: pollDelivered() never throws so the evidence dump above always runs; the boolean verdict is asserted here with the diagnostic message.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the page thaws — see the __streamRuntimeDebug dump above for the reconnect wedge`,
  ).toBe(true);
});

test("feed resumes after the /api WebSocket goes half-open (no close frame)", async ({
  helpers,
  page,
}) => {
  // The initial-reply wait (up to 120s) stacks on the probe window, the
  // paint wait (90s — see that step), and the two send assertions, so this
  // lane gets the heavy ceiling.
  test.setTimeout(360_000);
  await using fixture = await helpers.createFixture("suspend-halfopen");
  await installSocketKillSwitch(page);
  const consoleLines = captureStreamConsole(page);

  const agent = await fixture.createAgent();
  // A standing responder, not setOnce: this test drives TWO turns — the primer
  // below, and the mid-outage send further down that must eventually land.
  agent.responses.set(
    async () => '```ts\nasync (itx) => { await itx.chat.sendMessage("ready") }\n```',
  );
  await agent.message("Reply with exactly: ready");

  await page.goto(agent.webUrl);
  const keys = runtimeDebugKeys(fixture.project.id, agent.path);
  await waitForSubscribed(page, keys);

  // The composer initially renders a Send button before the initial reply's
  // activity reaches the browser. Waiting on that button alone can therefore
  // race with the reply and watch it turn into Stop generation
  // while the test fills its draft. First require the reply's durable
  // response event and its painted row; only then is Send a settled control.
  await test.step("half-open: wait for initial reply", async () => {
    await agent.stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [WEB_MESSAGE_SENT],
      timeoutMs: 120_000,
    });
  });
  // The durable reply already exists; these waits only let its live browser
  // mirror paint and settle the composer. There is intentionally no spinner in
  // that push-only gap, so Middlewright's 1ms no-progress clamp must not replace
  // the explicit bounded waits.
  await test.step("half-open: paint reply and settle composer", async () => {
    await spinnerWaiter.settings.run({ disabled: true }, async () => {
      // 90s, not 30s: on a cold preview deployment this first paint rides a
      // freshly deployed worker plus a cold Stream DO chain, and 30s failed
      // BOTH in-run tries on 3 of 5 preview runs during 2026-08-07 (every
      // job-level retry passed — pure cold-start latency, and this step runs
      // BEFORE any half-open is induced, so no resilience signal is at
      // stake). The 120s waits around this step already assume this lane is
      // slow. If this step keeps flaking at 90s, stop bumping and QUARANTINE
      // the spec per docs/testing.md — at that point the lane is telling us
      // preview first-paint has a real problem, and absorbing it here would
      // hide it.
      await page
        .locator('[data-testid="agent-feed-message"][data-kind="assistant"]')
        .first()
        .waitFor({ timeout: 90_000 }); // timeout: manual, see the cold-preview note above — spinner-waiter is disabled for this step
      await page.getByRole("button", { name: "Send message" }).waitFor({ timeout: 120_000 }); // timeout: manual, same cold-preview lane — spinner-waiter is disabled for this step
    });
  });

  // Blackhole the transport WITHOUT a close event — what a suspend-killed TCP
  // connection looks like when the OS never surfaces the death. Every capnweb
  // call now hangs; the socket map still holds the corpse, so recovery needs
  // the probe's timeout strikes to declare the transport suspect and evict it
  // (resetTransport) before a fresh dial can land.
  const socketsBaseline = await page.evaluate(() =>
    (window as unknown as { __countLiveApiSockets: () => number }).__countLiveApiSockets(),
  );
  const mutedUrls = await page.evaluate(() =>
    (window as unknown as { __muteAllApiSockets: () => string[] }).__muteAllApiSockets(),
  );
  console.log(`muted sockets: ${JSON.stringify(mutedUrls)} (baseline census ${socketsBaseline})`);
  expect(mutedUrls.length, "expected at least one live /api WebSocket to mute").toBeGreaterThan(0);

  // Send DURING the outage, before anything has noticed the death. The call
  // rides the corpse session; it can only settle when eviction CLOSES that
  // socket (capnweb rejects pending calls on transport close, the composer
  // surfaces the error and keeps the draft). The historical bug: eviction
  // closed the freshly-dialed SUCCESSOR instead (wake()'s synchronous
  // getSnapshot re-dial overwrote the transport slot before it was read), so
  // the corpse survived and the composer spun forever with no error — even
  // while the feed looked fully recovered.
  const sentDuringOutage = `during-outage-${Date.now()}`;
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByPlaceholder("Message this agent").fill(sentDuringOutage);
    await page.getByRole("button", { name: "Send message" }).click();
  });

  // A returning tab emits visibilitychange, which asks the socket owner to
  // verify NOW. Wait on the actual eviction invariant instead of sleeping a
  // guessed 35s (the old fixed wait was ~15s longer than the two 10s probe
  // windows it was trying to cover, and still supplied no evidence).
  await test.step("half-open: evict the muted transport after two probe strikes", async () => {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as { __mutedApiSocketsStillOpen: () => number }
            ).__mutedApiSocketsStillOpen(),
          ),
        { timeout: 30_000 }, // timeout: poll budget spanning two 10s probe strikes — outside the spinner-waiter's reach
      )
      .toBe(0);
  });
  console.log("--- after half-open probe window ---");
  console.log(JSON.stringify(await readDebugSnapshot(page), null, 2));

  const [marker] = await agent.stream.append({
    type: MARKER_EVENT_TYPE,
    payload: { marker: "after-half-open" },
  });
  const { delivered, snapshot } = await pollDelivered(
    page,
    keys,
    marker!.offset,
    RECOVERY_DELIVERY_MS,
  );
  dumpEvidence("after half-open", snapshot, consoleLines);
  // Historically the WORST wedge: connect() had no dial deadline, so the
  // runtime parked forever awaiting a stub on the muted session — not even a
  // reconnect timer armed.
  // oxlint-disable-next-line iterate/spec-restricted-syntax -- deliberate suspend-repro probe: pollDelivered() never throws so the evidence dump above always runs; the boolean verdict is asserted here with the diagnostic message.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the transport is evicted and re-dialed — see the __streamRuntimeDebug dump above`,
  ).toBe(true);

  // The user's half of the story: the stranded mid-outage send must SETTLE —
  // either it landed, or it rejected (composer re-enables, draft retained) and
  // a resend on the recovered transport lands. Never a forever-spinner. The
  // feed's live "Thinking…" state renders two spinner-matching elements, so
  // spinner-waiter sits this out (same per-call override as agent-chat.spec.ts).
  await test.step("half-open: settle or resend the message started during outage", async () => {
    await spinnerWaiter.settings.run({ disabled: true }, async () => {
      const sendButton = page.getByRole("button", { name: "Send message" });
      const sentRow = page
        .locator('[data-testid="agent-feed-message"][data-kind="user"]')
        .getByText(sentDuringOutage);
      // oxlint-disable-next-line iterate/spec-restricted-syntax -- deliberate half-open-repro probe: toPass() polls a compound settled-condition (row painted OR composer re-enabled) that no single locator can express.
      await expect(async () => {
        // Settled = the message painted (it landed) OR the button re-enabled
        // (it rejected and the draft is back). A still-spinning composer with
        // no row is the stranded-on-a-ghost-session wedge.
        const landed = await sentRow.isVisible();
        const enabled = await sendButton.isEnabled();
        // oxlint-disable-next-line iterate/spec-restricted-syntax -- the retry trigger inside the toPass loop above; the compound boolean is the settled-condition and the message names the wedge.
        expect(
          landed || enabled,
          "the mid-outage send never settled — stranded on a ghost session",
        ).toBe(true);
      }).toPass({ timeout: 60_000, intervals: [1_000] }); // timeout: toPass poll budget — outside the spinner-waiter's reach
      if (!(await sentRow.isVisible())) {
        // The stranded call rejected; the composer kept the draft — resend on
        // the recovered transport.
        await sendButton.click();
      }
      await sentRow.waitFor({ timeout: 30_000 }); // timeout: manual — spinner-waiter is disabled for this step
    });
  });

  // Leak census, two invariants: (1) every muted corpse was CLOSED — a
  // recovery that dials fresh but strands the corpse (the #1894 signature)
  // fails here even when the total count happens to look small; (2) the live
  // census returned to its pre-mute baseline — no accumulation per cycle.
  // Window: the resume sweep needs two 10s ping strikes before it evicts.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as { __mutedApiSocketsStillOpen: () => number }
          ).__mutedApiSocketsStillOpen(),
        ),
      { timeout: 20_000 }, // timeout: poll budget — expect.poll is outside the spinner-waiter's reach
    )
    .toBe(0);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __countLiveApiSockets: () => number }).__countLiveApiSockets(),
        ),
      { timeout: 10_000 }, // timeout: poll budget — expect.poll is outside the spinner-waiter's reach
    )
    .toBeLessThanOrEqual(socketsBaseline);
});

// The stream view mounts ONE browser mirror runtime on the agent stream — it
// downloads once and fans out to the canonical processors (raw events cache +
// feed projector). Its debug-registry key is `${projectId} ${streamPath}
// browser-stream-processors` (stream-browser-store.ts).
function runtimeDebugKeys(projectId: string, agentPath: string) {
  return [`${projectId} ${agentPath} browser-stream-processors`];
}

type RuntimeDebug = {
  connectionStatus?: string;
  connectionError?: string;
  lastDeliveredOffset?: number;
  [key: string]: unknown;
};
type DebugSnapshot = Record<string, RuntimeDebug>;

function readDebugSnapshot(page: Page): Promise<DebugSnapshot> {
  return page.evaluate(() => {
    const read = (window as { __streamRuntimeDebug?: () => Record<string, unknown> })
      .__streamRuntimeDebug;
    return (typeof read === "function" ? read() : {}) as DebugSnapshot;
  });
}

async function waitForSubscribed(page: Page, keys: string[], timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last: DebugSnapshot = {};
  for (;;) {
    last = await readDebugSnapshot(page);
    if (keys.every((key) => last[key]?.connectionStatus === "receiving-events")) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for runtimes ${keys.join(", ")} to reach "receiving-events". Last __streamRuntimeDebug:\n${JSON.stringify(last, null, 2)}`,
      );
    }
    // timeout: poll pacing on a debug-snapshot read the spinner-waiter can't extend
    await page.waitForTimeout(500);
  }
}

/** Poll until every runtime's lastDeliveredOffset reaches `offset`. Never throws. */
async function pollDelivered(page: Page, keys: string[], offset: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: DebugSnapshot = {};
  for (;;) {
    last = await readDebugSnapshot(page);
    const delivered = keys.every((key) => (last[key]?.lastDeliveredOffset ?? -1) >= offset);
    if (delivered || Date.now() > deadline) return { delivered, snapshot: last };
    // timeout: poll pacing on a debug-snapshot read the spinner-waiter can't extend
    await page.waitForTimeout(1_000);
  }
}

function installSuspendTimerProbe(page: Page) {
  return page.addInitScript(() => {
    const timerEvidence: SuspendTimerEvidence = { maxTimerGapMs: 0 };
    let previousTimerTick = performance.now();
    let armed = false;
    setInterval(() => {
      const timerTick = performance.now();
      if (armed)
        timerEvidence.maxTimerGapMs = Math.max(
          timerEvidence.maxTimerGapMs,
          timerTick - previousTimerTick,
        );
      previousTimerTick = timerTick;
    }, 50);
    const testWindow = window as unknown as {
      __suspendTimerEvidence: SuspendTimerEvidence;
      __armSuspendTimerProbe: () => void;
    };
    testWindow.__suspendTimerEvidence = timerEvidence;
    testWindow.__armSuspendTimerProbe = () => {
      timerEvidence.maxTimerGapMs = 0;
      previousTimerTick = performance.now();
      armed = true;
    };
  });
}

/**
 * Registry of live main-thread WebSockets + two failure switches for the /api
 * ones (the itx capnweb transport — the stream runtimes ride it too). Must be
 * installed BEFORE navigation. Only /api sockets are touched: killing the Vite
 * HMR socket would make the dev client reload the page on reconnect, which is
 * exactly the recovery the bug report says users are forced into.
 *
 *   __closeAllApiSockets — clean close, the "close event delivered" lane.
 *   __closeAllApiSocketsAndWait — clean close, resolving only after every
 *     original socket emitted close; a replacement socket does not hold it up.
 *   __muteAllApiSockets  — half-open simulation: sends are swallowed and
 *     message events suppressed, but no close ever fires. This is what a
 *     mobile-suspend-killed TCP connection looks like to the page when the OS
 *     never surfaces the death: every RPC hangs forever.
 */
function installSocketKillSwitch(page: Page) {
  return page.addInitScript(() => {
    const registry = new Set<WebSocket>();
    const muted = new WeakSet<WebSocket>();
    const NativeWebSocket = window.WebSocket;
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        registry.add(this);
        this.addEventListener("close", () => registry.delete(this));
      }
      override send(data: Parameters<WebSocket["send"]>[0]) {
        if (muted.has(this)) return;
        super.send(data);
      }
      // Muting rides an addEventListener wrapper, which is sound for capnweb's
      // browser build specifically: it attaches message listeners as FUNCTIONS
      // via addEventListener (never `onmessage =`, never handleEvent objects)
      // and never removes them (the wrapper identity break would defeat
      // removeEventListener). Re-verify on a capnweb bump or this spec's
      // half-open lane silently stops muting.
      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === "message" && typeof listener === "function") {
          super.addEventListener(
            type,
            (event: Event) => {
              if (!muted.has(this)) listener.call(this, event);
            },
            options,
          );
          return;
        }
        super.addEventListener(type, listener, options);
      }
    }
    window.WebSocket = TrackedWebSocket as typeof WebSocket;
    const apiSockets = () =>
      [...registry].filter((ws) => {
        try {
          const pathname = new URL(ws.url).pathname;
          return pathname === "/api" || pathname.startsWith("/api/");
        } catch {
          return false;
        }
      });
    (window as { __closeAllApiSockets?: () => string[] }).__closeAllApiSockets = () => {
      const closed: string[] = [];
      for (const ws of apiSockets()) {
        closed.push(ws.url);
        ws.close();
      }
      return closed;
    };
    (
      window as {
        __closeAllApiSocketsAndWait?: () => Promise<string[]>;
      }
    ).__closeAllApiSocketsAndWait = async () => {
      const sockets = apiSockets();
      const closed = sockets.map((ws) => ws.url);
      if (sockets.length === 0) return closed;
      await new Promise<void>((resolve, reject) => {
        let remaining = sockets.length;
        const timeout = setTimeout(
          () =>
            reject(new Error(`${remaining}/${sockets.length} original /api sockets did not close`)),
          5_000,
        );
        for (const ws of sockets) {
          ws.addEventListener(
            "close",
            () => {
              remaining -= 1;
              if (remaining === 0) {
                clearTimeout(timeout);
                resolve();
              }
            },
            { once: true },
          );
          ws.close();
        }
      });
      return closed;
    };
    const mutedList: WebSocket[] = [];
    (window as { __muteAllApiSockets?: () => string[] }).__muteAllApiSockets = () => {
      const mutedUrls: string[] = [];
      for (const ws of apiSockets()) {
        mutedUrls.push(ws.url);
        muted.add(ws);
        mutedList.push(ws);
      }
      return mutedUrls;
    };
    // The registry sheds sockets on their close event, so this counts sockets
    // that are genuinely still alive — the leak census. Historically each
    // eviction left one never-closed corpse behind (eviction closed the fresh
    // successor instead), so the census grew by one per suspend cycle.
    (window as { __countLiveApiSockets?: () => number }).__countLiveApiSockets = () =>
      apiSockets().length;
    // The sharper invariant: every muted corpse must eventually be CLOSED
    // (readyState CLOSING/CLOSED). A recovery that dials fresh but strands
    // the corpse passes a bare census of "small number" — this doesn't.
    (window as { __mutedApiSocketsStillOpen?: () => number }).__mutedApiSocketsStillOpen = () =>
      mutedList.filter((ws) => ws.readyState < WebSocket.CLOSING).length;
  });
}

function readSuspendTimerEvidence(page: Page) {
  return page.evaluate(() => {
    const evidence = (
      window as unknown as {
        __suspendTimerEvidence?: SuspendTimerEvidence;
      }
    ).__suspendTimerEvidence;
    if (!evidence) throw new Error("suspend timer evidence was not installed before navigation");
    return evidence;
  });
}

/** The store logs its reconnect decisions under "[stream …]"; keep them as evidence. */
function captureStreamConsole(page: Page) {
  const lines: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[stream") || text.includes("[vite]")) {
      lines.push(`${new Date().toISOString()} ${message.type()}: ${text}`);
    }
  });
  return lines;
}

function dumpEvidence(label: string, snapshot: DebugSnapshot, consoleLines: string[]) {
  console.log(`--- ${label}: __streamRuntimeDebug() ---`);
  console.log(JSON.stringify(snapshot, null, 2));
  console.log(`--- ${label}: [stream …] console lines ---`);
  console.log(consoleLines.join("\n") || "(none)");
}
