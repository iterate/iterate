import { expect, type Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Regression suite for the "stream feed wedges after browser suspend" bug:
// the stream view's runtime factory used to close over the itx capnweb handle
// captured at mount (project-stream-view.tsx), acquireStreamRuntime deduped by
// (projectId, streamPath, slug) and ignored fresh factories on re-acquire
// (stream-browser-store.ts), so once the /api WebSocket died the runtime's
// reconnect loop kept dialing through the dead capnweb session forever. The
// itx socket map itself re-dialed fine — only the stream runtimes stayed
// wedged until a full page reload. The fix: per-call transport resolution in
// the view's source, factory refresh on re-acquire, a dial deadline, and
// resetTransport eviction for the half-open lane.
//
// Assertions ride window.__streamRuntimeDebug() (stream-browser-store.ts's
// debug registry) — transport-level truth, immune to UI-layer noise.

const ONBOARDING_AGENT_PATH = "/agents/onboarding";
const MARKER_EVENT_TYPE = "events.iterate.test/spec/suspend-marker";

// Two liveness-probe intervals (LIVENESS_PROBE_INTERVAL_MS = 10s): a clean
// socket close is invisible to the runtime (the view's factory never wires
// onConnectionStatusChange), so only the probe notices the dead session —
// a rejection reconnects on the first probe, timeouts need two strikes.
const PROBE_NOTICE_MS = 25_000;

// Fresh streams' first post-subscribe delivery can stall and needs the ~10s
// probe self-heal (see reactivity.spec.ts's DELIVERY_WAIT rationale), so the
// healthy-path window is 30s, not the theoretical "instant".
const HEALTHY_DELIVERY_MS = 30_000;
// Post-death recovery window. Worst case is the half-open lane: up to two
// probe intervals + two 5s probe timeouts to declare the transport suspect,
// then resetTransport + a fresh dial + election + subscribe — measured ~40-56s
// locally, so 90s leaves headroom for slower preview CI boxes without hiding
// a real wedge (the wedge is permanent; any finite window catches it).
const RECOVERY_DELIVERY_MS = 90_000;

// The stream view mounts two browser runtimes on the agent stream (raw events
// mirror + feed projector); the feed one paints the chat. Debug-registry keys
// are `${projectId} ${streamPath} ${slug}` (stream-browser-store.ts).
function runtimeDebugKeys(projectId: string) {
  return [
    `${projectId} ${ONBOARDING_AGENT_PATH} browser-raw-events`,
    `${projectId} ${ONBOARDING_AGENT_PATH} browser-feed`,
  ];
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
    if (keys.every((key) => last[key]?.connectionStatus === "subscribed")) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for runtimes ${keys.join(", ")} to reach "subscribed". Last __streamRuntimeDebug:\n${JSON.stringify(last, null, 2)}`,
      );
    }
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
    await page.waitForTimeout(1_000);
  }
}

/**
 * Registry of live main-thread WebSockets + two failure switches for the /api
 * ones (the itx capnweb transport — the stream runtimes ride it too). Must be
 * installed BEFORE navigation. Only /api sockets are touched: killing the Vite
 * HMR socket would make the dev client reload the page on reconnect, which is
 * exactly the recovery the bug report says users are forced into.
 *
 *   __closeAllApiSockets — clean close, the "close event delivered" lane.
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
    (window as { __muteAllApiSockets?: () => string[] }).__muteAllApiSockets = () => {
      const mutedUrls: string[] = [];
      for (const ws of apiSockets()) {
        mutedUrls.push(ws.url);
        muted.add(ws);
      }
      return mutedUrls;
    };
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

test("control: appended event is delivered to a live stream feed", async ({
  helpers,
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("suspend-control");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  const consoleLines = captureStreamConsole(page);

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  using agent = project.agents.get(ONBOARDING_AGENT_PATH);

  await page.goto(`/projects/${fixture.project.slug}/agents/streams/agents/onboarding`);
  const keys = runtimeDebugKeys(fixture.project.id);
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
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered to a healthy subscription`,
  ).toBe(true);
});

test("feed resumes after the /api WebSocket dies (clean close)", async ({
  helpers,
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("suspend-socket");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  await installSocketKillSwitch(page);
  const consoleLines = captureStreamConsole(page);

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  using agent = project.agents.get(ONBOARDING_AGENT_PATH);

  await page.goto(`/projects/${fixture.project.slug}/agents/streams/agents/onboarding`);
  const keys = runtimeDebugKeys(fixture.project.id);
  await waitForSubscribed(page, keys);

  // Kill the itx transport from inside the page — the "close event delivered"
  // lane (mobile Safari suspend, proxy idle timeout, …). The itx socket map
  // drops its entry; the runtimes' per-call source must reach the fresh dial.
  const closed = await page.evaluate(() =>
    (window as unknown as { __closeAllApiSockets: () => string[] }).__closeAllApiSockets(),
  );
  console.log(`closed sockets: ${JSON.stringify(closed)}`);
  expect(closed.length, "expected at least one live /api WebSocket to close").toBeGreaterThan(0);

  // Give the liveness probe two intervals to notice and enter its reconnect loop.
  await page.waitForTimeout(PROBE_NOTICE_MS);
  console.log("--- after probe window ---");
  console.log(JSON.stringify(await readDebugSnapshot(page), null, 2));

  const [marker] = await agent.stream.append({
    type: MARKER_EVENT_TYPE,
    payload: { marker: "after-socket-death" },
  });
  const { delivered, snapshot } = await pollDelivered(
    page,
    keys,
    marker!.offset,
    RECOVERY_DELIVERY_MS,
  );
  dumpEvidence("after socket death", snapshot, consoleLines);
  // The historical wedge: runtimes stuck in connectionStatus "reconnecting"
  // with connectionError "connect failed: Peer closed WebSocket: 1005"
  // forever, dialing through the dead mount-time capnweb session.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the browser re-dials /api — see the __streamRuntimeDebug dump above for the reconnect wedge`,
  ).toBe(true);
});

test("feed resumes after page freeze + socket death (mobile suspend shape)", async ({
  helpers,
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("suspend-freeze");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  await installSocketKillSwitch(page);
  const consoleLines = captureStreamConsole(page);

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  using agent = project.agents.get(ONBOARDING_AGENT_PATH);

  await page.goto(`/projects/${fixture.project.slug}/agents/streams/agents/onboarding`);
  const keys = runtimeDebugKeys(fixture.project.id);
  await waitForSubscribed(page, keys);

  // Mobile suspend ≈ frozen page + the OS reaping the TCP connection. Script
  // execution is suspended while frozen, so the socket close must happen
  // BEFORE Page.setWebLifecycleState (page.evaluate would hang otherwise);
  // setOffline while frozen additionally models the radio dropping, though
  // CDP's emulateNetworkConditions does not reliably kill established
  // WebSockets on its own — the explicit close is the guaranteed death.
  const cdp = await page.context().newCDPSession(page);
  const closed = await page.evaluate(() =>
    (window as unknown as { __closeAllApiSockets: () => string[] }).__closeAllApiSockets(),
  );
  console.log(`closed sockets: ${JSON.stringify(closed)}`);
  expect(closed.length, "expected at least one live /api WebSocket to close").toBeGreaterThan(0);
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await page.context().setOffline(true);
  await page.waitForTimeout(25_000);
  await page.context().setOffline(false);
  await cdp.send("Page.setWebLifecycleState", { state: "active" });

  // Timers were suspended while frozen: the probe strikes only start now.
  await page.waitForTimeout(PROBE_NOTICE_MS);
  console.log("--- after thaw + probe window ---");
  console.log(JSON.stringify(await readDebugSnapshot(page), null, 2));

  const [marker] = await agent.stream.append({
    type: MARKER_EVENT_TYPE,
    payload: { marker: "after-freeze" },
  });
  const { delivered, snapshot } = await pollDelivered(
    page,
    keys,
    marker!.offset,
    RECOVERY_DELIVERY_MS,
  );
  dumpEvidence("after freeze", snapshot, consoleLines);
  // Historically the same wedge as the clean-close test — the frozen window
  // only delayed when the liveness probe noticed.
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the page thaws — see the __streamRuntimeDebug dump above for the reconnect wedge`,
  ).toBe(true);
});

test("feed resumes after the /api WebSocket goes half-open (no close frame)", async ({
  helpers,
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("suspend-halfopen");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
  await installSocketKillSwitch(page);
  const consoleLines = captureStreamConsole(page);

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  using agent = project.agents.get(ONBOARDING_AGENT_PATH);

  await page.goto(`/projects/${fixture.project.slug}/agents/streams/agents/onboarding`);
  const keys = runtimeDebugKeys(fixture.project.id);
  await waitForSubscribed(page, keys);

  // Blackhole the transport WITHOUT a close event — what a suspend-killed TCP
  // connection looks like when the OS never surfaces the death. Every capnweb
  // call now hangs; the socket map still holds the corpse, so recovery needs
  // the probe's timeout strikes to declare the transport suspect and evict it
  // (resetTransport) before a fresh dial can land.
  const mutedUrls = await page.evaluate(() =>
    (window as unknown as { __muteAllApiSockets: () => string[] }).__muteAllApiSockets(),
  );
  console.log(`muted sockets: ${JSON.stringify(mutedUrls)}`);
  expect(mutedUrls.length, "expected at least one live /api WebSocket to mute").toBeGreaterThan(0);

  // Two probe intervals + two probe timeouts before the transport is evicted.
  await page.waitForTimeout(PROBE_NOTICE_MS + 10_000);
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
  expect(
    delivered,
    `marker at offset ${marker!.offset} should be delivered after the transport is evicted and re-dialed — see the __streamRuntimeDebug dump above`,
  ).toBe(true);

  // The user's half of the story: after recovery, a send from the BROWSER
  // composer must settle and paint. Historically eviction only unmapped the
  // dead session (never closed it), so a send could hang forever on the ghost
  // even while the feed looked recovered. The feed's live "Thinking…" state
  // renders two spinner-matching elements, so spinner-waiter sits this out
  // (same per-call override as agent-chat.spec.ts).
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    const sent = `resumed-${Date.now()}`;
    await page.getByPlaceholder("Message this agent").fill(sent);
    await page.getByRole("button", { name: "Send message" }).click();
    await page
      .locator('[data-testid="agent-feed-message"][data-kind="user"]')
      .getByText(sent)
      .waitFor({ timeout: 30_000 });
  });
});
