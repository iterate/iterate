// Where the seconds go between pressing the button and the call being live.
//
//   doppler run --config prd -- pnpm cli voicelab latency --project voice-test
//   doppler run --config prd -- pnpm cli voicelab latency --project voice-test --last 10
//
// WHY THIS EXISTS. "It takes ages to connect" is a real complaint and an
// unactionable one: a call bring-up crosses a device, a stream, a processor, a
// dynamic worker that may need building, a Durable Object that may be cold, and
// a provider handshake — and a single number for the lot invites a guess about
// which of them is slow. Every stamp below is already written down by the code
// that owns that phase, so this reads the durable record rather than measuring
// anything itself, and it can be run against a call that happened yesterday.
//
// THE LADDER, and who stamps each rung:
//
//   conversation-requested   the DEVICE, when the person pressed the button
//     ├ wake                 stream delivery + processor + dynamic worker build
//     ├ dial                 the bridge's WebSocket upgrade to the provider
//     ├ session              the provider answering with session.created
//     ├ accept               our session.update round trip (session.updated)
//     └ append               conversation-accepted reaching the stream
//   conversation-accepted    what the device is waiting for to show "ready"
//
// `wake` is the segment nothing else can see: it is the difference between the
// device's own append time and the bridge's first instant, and it is where a
// cold dynamic worker shows up.
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab latency`. */
export interface LatencyOptions extends VoicelabConnectOptions {
  /** How many recent conversations to read. */
  last?: number;
  /** Read one named conversation instead of the recent ones. */
  path?: string;
  /** Write the ladder for every call here as JSON. */
  out?: string;
  /**
   * Press the button on this board (`itx.kit.<name>`) and time the whole thing.
   *
   * Without it this reads calls that already happened, and the ladder starts at
   * `conversation-requested` — which is the device's SECOND act. Pressing here
   * is the only way to see the first one, and the device-side segment turned out
   * to be the larger half.
   */
  board?: string;
  /** How many presses to make on that board. */
  presses?: number;
  /**
   * Milliseconds to leave the board alone between calls.
   *
   * The device prepares its NEXT conversation while idle, which is what makes a
   * press cheap — so pressing again immediately measures the prepare, not the
   * press. A person does not do that; four seconds was the harness being
   * unrealistic and reading its own impatience as device latency.
   */
  settle?: number;
}

/** One event, as much of it as this reader needs. */
interface StreamEventLike {
  offset: number;
  type: string;
  createdAt: string;
  payload?: unknown;
}

/** The stream methods used here. */
interface StreamReader {
  getEventPage(args: { limit: number }): Promise<{ streamMaxOffset?: number } | null>;
  getEvents(args: { afterOffset: number; limit: number }): Promise<StreamEventLike[] | null>;
}

/**
 * One call's bring-up, in milliseconds per rung.
 *
 * Every field is a DURATION except `path` and `totalMs`, and they sum to
 * `totalMs` — a rung that cannot be computed (an older call that predates the
 * stamp) is null rather than zero, because zero is a claim.
 */
export interface CallLadder {
  path: string;
  conversationId: string;
  /** When the device asked, on the device's clock. The ladder's zero. */
  requestedAtMs: number;
  /**
   * The press to `conversation-requested`: the device's OWN half.
   *
   * Only known when this harness did the pressing. It covers `setupVoiceAgent`
   * — minting the stream, the agent, the capability host, three system prompts
   * and the warm-up handshake — none of which the device starts until somebody
   * asks for a call.
   */
  pressMs?: number | null;
  /** Press to the device reporting `callActive`, when we pressed. */
  liveMs?: number | null;
  /** Button press to the device seeing its call accepted. The whole complaint. */
  totalMs: number | null;
  /** Device append → the bridge's first instant. Cold worker builds live here. */
  wakeMs: number | null;
  /** The bridge's WebSocket upgrade to the provider. */
  dialMs: number | null;
  /** Upgrade → `session.created`: the provider deciding to talk to us. */
  sessionMs: number | null;
  /** `session.created` → `session.updated`: our own configuration round trip. */
  acceptMs: number | null;
  /** `session.updated` → the accepted event landing on the stream. */
  appendMs: number | null;
  /** How many times the bridge had to redial the provider to get there. */
  redials: number | null;
  /** Absent when the call was never accepted; the reason, when one was written. */
  failed?: string;
}

/** The phase stamps the bridge writes into `conversation-accepted`. */
interface AcceptedPhases {
  bridgeEnteredAt?: number;
  providerDialledMs?: number;
  providerReadyMs?: number;
  acceptedMs?: number;
}

/** Every timestamped conversation on this project, newest last. */
async function recentConversations(
  itx: { streams: { list(args: { prefix: string }): Promise<unknown> } },
  last: number,
): Promise<string[]> {
  const listed = (await itx.streams.list({ prefix: "/agents/voice/" })) as Array<
    { path?: string } | string
  > | null;
  const paths = (listed ?? []).map((entry) =>
    typeof entry === "string" ? entry : (entry.path ?? ""),
  );
  /* Timestamped ones only — the fixed paths people set up by hand (`device`,
   * `face-check`) sort after every date and would win a plain "last". */
  return paths
    .filter((path) => /\/\d{4}-\d{2}-\d{2}-\d{6}$/.test(path))
    .sort()
    .slice(-last)
    .map((path) => path.replace(/^\/workspaces/, ""));
}

/** Read one conversation and work out its bring-up ladder. */
async function ladderFor(stream: StreamReader, path: string): Promise<CallLadder | null> {
  const page = await stream.getEventPage({ limit: 1 });
  const head = page?.streamMaxOffset ?? 0;
  let requestedAt: number | null = null;
  let conversationId = "";
  let acceptedAt: number | null = null;
  let phases: AcceptedPhases | null = null;
  let redials: number | null = null;
  let failed: string | undefined;
  let offset = 0;
  /* Paged to the platform's ceiling of 500: a busy call runs to thousands of
   * offsets and asking for more is an error. */
  while (offset < head) {
    const batch = (await stream.getEvents({ afterOffset: offset, limit: 500 })) ?? [];
    if (batch.length === 0) break;
    let moved = false;
    for (const event of batch) {
      if (event.offset > offset) {
        offset = event.offset;
        moved = true;
      }
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === "events.iterate.com/voice-agent/conversation-requested") {
        /* The FIRST request, not the last: a person who presses again because
         * nothing happened has not restarted the clock on their patience. */
        requestedAt ??= Date.parse(event.createdAt);
        conversationId ||= String(payload.conversationId ?? "");
      }
      if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
        acceptedAt ??= Date.parse(event.createdAt);
        phases ??= (payload.phases ?? null) as AcceptedPhases | null;
        redials ??= typeof payload.redials === "number" ? payload.redials : null;
      }
      if (event.type === "events.iterate.com/voice-agent/conversation-failed") {
        failed ??= String(payload.reason ?? "");
      }
    }
    if (!moved) break;
  }
  if (requestedAt === null) return null;

  const entered = phases?.bridgeEnteredAt ?? null;
  const dialled = phases?.providerDialledMs ?? null;
  const ready = phases?.providerReadyMs ?? null;
  const accepted = phases?.acceptedMs ?? null;
  /* Each rung is the difference between two stamps on the SAME clock, so a
   * clock offset between the device and the worker can only ever land in
   * `wakeMs` — never smeared across the provider phases. */
  return {
    acceptMs: ready !== null && accepted !== null ? accepted - ready : null,
    appendMs:
      entered !== null && accepted !== null && acceptedAt !== null
        ? acceptedAt - (entered + accepted)
        : null,
    conversationId,
    dialMs: dialled,
    ...(failed === undefined ? {} : { failed }),
    path,
    redials,
    requestedAtMs: requestedAt,
    sessionMs: dialled !== null && ready !== null ? ready - dialled : null,
    totalMs: acceptedAt === null ? null : acceptedAt - requestedAt,
    wakeMs: entered === null ? null : entered - requestedAt,
  };
}

/** `1234` → `1.2s`, and null → `—`, so a column of these reads at a glance. */
function secs(ms: number | null): string {
  if (ms === null) return "     —";
  return `${(ms / 1000).toFixed(1)}s`.padStart(6);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A board's health, as much of it as the press timer reads. */
interface KitHandle {
  health(): Promise<Record<string, unknown>>;
  conversation: { start(): Promise<unknown>; end(): Promise<unknown> };
}

/**
 * Press the button, and time everything from the press.
 *
 * Health is read on a tight poll rather than waited on: adopting a conversation
 * REMOUNTS the capability, so for a second or two the handle genuinely is not
 * there, and a read that throws is the handshake working.
 */
async function pressAndTime(
  kit: KitHandle,
  presses: number,
  settleMs: number,
): Promise<{ pressedAt: number; liveMs: number | null; path: string }[]> {
  const runs: { pressedAt: number; liveMs: number | null; path: string }[] = [];
  for (let index = 0; index < presses; index++) {
    const pressedAt = Date.now();
    await kit.conversation.start();
    let liveMs: number | null = null;
    let path = "";
    let last: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const health = await kit.health();
        last = health;
        path ||= String(health.conversation ?? "");
        if (health.callActive === true) {
          liveMs = Date.now() - pressedAt;
          path = String(health.conversation ?? path);
          break;
        }
      } catch {
        /* remount window; ask again */
      }
      await sleep(250);
    }
    runs.push({ liveMs, path, pressedAt });
    console.error(
      `  press ${String(index + 1)}: live after ${liveMs === null ? "never" : `${String(liveMs)}ms`}`,
    );
    /*
     * WHAT THE DEVICE WAS DOING WHEN IT DID NOT ANSWER. "never" on its own sent
     * me to the wrong half of the system twice: the board had restarted itself,
     * and the harness reported that as a slow call. `restartNote` is the device
     * saying why, in its own words, across the restart that erased everything
     * else.
     */
    if (liveMs === null) {
      console.error(
        `    device: ${JSON.stringify({
          callPending: last.callPending,
          connection: last.connection,
          pings: last.pings,
          resetReason: last.resetReason,
          rpc: `exports ${String(last.rpcExports)}/${String(last.rpcExportsMax)} imports ${String(last.rpcImports)}/${String(last.rpcImportsMax)} calls ${String(last.rpcCalls)}/${String(last.rpcCallsMax)}`,
          restartNote: last.restartNote,
          transport: last.transport,
          uptimeMs: last.uptimeMs,
          voicelab: last.voicelab,
          voicelabFailure: last.voicelabFailure,
          wantsCall: last.wantsCall,
        })}`,
      );
    }
    try {
      await kit.conversation.end();
    } catch {
      /* ending a call that never started is not this measurement's problem */
    }
    /* Long enough for the device to notice the call ended AND prepare its next
     * conversation: pressing again into that prepare measures the prepare. */
    await sleep(settleMs);
  }
  return runs;
}

export async function latency(options: LatencyOptions) {
  using itx = await connectProject(options);
  const streams = (itx as never as { streams: { get(path: string): StreamReader } }).streams;

  /* When a board is named, the paths come from the presses we just made — never
   * from "the newest streams", which on a busy project is somebody else's call. */
  let pressed: { pressedAt: number; liveMs: number | null; path: string }[] = [];
  if (options.board !== undefined) {
    const kit = (itx as unknown as { kit: Record<string, KitHandle> }).kit[options.board];
    if (!kit) throw new Error(`nothing mounted at itx.kit.${options.board}`);
    pressed = await pressAndTime(kit, options.presses ?? 3, options.settle ?? 20_000);
  }

  const paths =
    pressed.length > 0
      ? pressed.map((run) => run.path).filter((path) => path.length > 0)
      : options.path === undefined
        ? await recentConversations(itx as never, options.last ?? 5)
        : [options.path];

  const ladders: CallLadder[] = [];
  for (const path of paths) {
    const ladder = await ladderFor(streams.get(path), path);
    /* A conversation stream with no call on it is setup that nobody rang; it is
     * not a fast call and must not be averaged as one. */
    if (ladder === null) continue;
    const run = pressed.find((entry) => entry.path === path);
    if (run !== undefined) {
      ladder.liveMs = run.liveMs;
      /* requested − pressed: everything the device did before it asked. */
      ladder.pressMs = ladder.requestedAtMs - run.pressedAt;
    }
    ladders.push(ladder);
  }

  /* The press columns are only honest when this harness did the pressing. */
  const drove = ladders.some((call) => call.pressMs !== undefined);
  const head = drove
    ? "  conversation            press   live |  total    wake    dial session  accept"
    : "  conversation            total    wake    dial session  accept  append  redials";
  console.error("");
  console.error(head);
  console.error(`  ${"─".repeat(head.length - 2)}`);
  for (const call of ladders) {
    const name = (call.path.split("/").at(-1) ?? call.path).padEnd(22);
    const line = drove
      ? `  ${name} ${secs(call.pressMs ?? null)} ${secs(call.liveMs ?? null)} | ` +
        `${secs(call.totalMs)} ${secs(call.wakeMs)} ${secs(call.dialMs)} ` +
        `${secs(call.sessionMs)} ${secs(call.acceptMs)}`
      : `  ${name} ${secs(call.totalMs)} ${secs(call.wakeMs)} ${secs(call.dialMs)} ` +
        `${secs(call.sessionMs)} ${secs(call.acceptMs)} ${secs(call.appendMs)} ` +
        `${String(call.redials ?? "—").padStart(8)}`;
    console.error(
      line + (call.failed === undefined ? "" : `  FAILED: ${call.failed.slice(0, 60)}`),
    );
  }
  /*
   * The median, not the mean: one cold build among ten warm calls is the story
   * of that build, and averaging it in tells you about a call nobody made.
   */
  const median = (pick: (call: CallLadder) => number | null): number | null => {
    const values = ladders
      .map(pick)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    return values.length === 0 ? null : (values[Math.floor(values.length / 2)] ?? null);
  };
  console.error(`  ${"─".repeat(head.length - 2)}`);
  const label = `median of ${String(ladders.length)}`.padEnd(22);
  console.error(
    drove
      ? `  ${label} ${secs(median((c) => c.pressMs ?? null))} ${secs(median((c) => c.liveMs ?? null))} | ` +
          `${secs(median((c) => c.totalMs))} ${secs(median((c) => c.wakeMs))} ` +
          `${secs(median((c) => c.dialMs))} ${secs(median((c) => c.sessionMs))} ` +
          `${secs(median((c) => c.acceptMs))}`
      : `  ${label} ${secs(median((c) => c.totalMs))} ` +
          `${secs(median((c) => c.wakeMs))} ${secs(median((c) => c.dialMs))} ` +
          `${secs(median((c) => c.sessionMs))} ${secs(median((c) => c.acceptMs))} ` +
          `${secs(median((c) => c.appendMs))}`,
  );
  console.error("");

  if (options.out !== undefined) {
    const fs = await import("node:fs");
    fs.writeFileSync(options.out, JSON.stringify(ladders, null, 2));
  }
  return ladders;
}
