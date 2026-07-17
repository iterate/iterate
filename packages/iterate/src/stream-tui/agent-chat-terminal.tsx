#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
// oxlint-disable react/only-export-components -- CLI entrypoint, not a Vite Fast Refresh module.
/**
 * React/OpenTUI terminal chat with one project agent.
 *
 * The data layer is the SAME client stack the web app renders from: the
 * one-socket session keeper (`iterate/client`, pointed at the deployment via
 * `configureIterateSession`) and the shared React hooks (`iterate/react` —
 * `useItxSubscription` owns reconnect, watchdog, and re-subscribe recovery),
 * folding stream events through the shared agent-ui reducer
 * (@iterate-com/ui). Sends go through `agent.message` on the same socket.
 * This file owns the app shell and terminal runtime state; the presentational
 * components live in ./chat-view.tsx. OpenTUI is just another React renderer,
 * so the hooks (TanStack Query included) run here unchanged.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  configureIterateSession,
  connectItx,
  useItxSubscription,
  type Itx,
} from "../itx/itx-react.ts";
import {
  ensureOnboardingAgentReady,
  ONBOARDING_AGENT_PATH,
} from "../../../../apps/os/src/lib/onboarding-agent.ts";
import { createAgentFeedModel, type AgentFeedSnapshot } from "./agent-feed-model.ts";
import { resolveItxAuth } from "./itx-auth.ts";
import { ChatHeader, FeedItem, LiveActivity } from "./chat-view.tsx";
import { COLORS } from "./chat-colors.ts";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("iterate chat requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));

// One keeper socket for the whole process — the TUI's equivalent of the
// browser tab. Everything below (subscription, sends) rides it.
configureIterateSession({
  baseUrl: args.baseUrl,
  credentials: resolveItxAuth({ configName: process.env.ITERATE_CONFIG_NAME }),
});

// ---------------------------------------------------------------------------
// App state: one feed model, exposed to React through a tiny external store
// (the subscription's event batches arrive outside React).
// ---------------------------------------------------------------------------

const model = createAgentFeedModel();
let feedSnapshot: AgentFeedSnapshot = model.snapshot();
const feedListeners = new Set<() => void>();

function publishFeed() {
  feedSnapshot = model.snapshot();
  for (const listener of feedListeners) listener();
}

/**
 * Establish the live agent feed on the shared socket: ensure the agent exists,
 * then subscribe from the feed model's resume cursor. The onboarding agent is
 * deliberately NOT born at project bootstrap (a birth costs a real LLM turn) —
 * opening its chat births it, in the web dashboard and here alike, with the
 * same explicit startup events. useItxSubscription re-runs this on every
 * recovery, so the cursor read is per-(re)subscribe and replay overlap is
 * folded out by the model's offset dedupe.
 */
async function subscribeAgentFeed(itx: Itx) {
  // ONE agent path stub per (re)subscribe cycle, released once the
  // subscription handle exists — on the process-long keeper socket an
  // undisposed stub per recovery cycle would grow the import table forever.
  const agent = itx.agents.get(args.agentPath);
  try {
    if (args.agentPath === ONBOARDING_AGENT_PATH) {
      await ensureOnboardingAgentReady({ agent });
    } else {
      const snapshot = await agent.processor.snapshot();
      if (snapshot.state.birthCertificate === null) await agent.create();
    }
    return await agent.stream.subscribe({
      processEventBatch: (batch) => {
        if (model.applyEvents(batch.events)) publishFeed();
      },
      replayAfterOffset: model.snapshot().lastOffset,
      subscriber: { description: "iterate chat TUI" },
    });
  } finally {
    (agent as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

// ---------------------------------------------------------------------------
// The app shell
// ---------------------------------------------------------------------------

function AgentChatApp() {
  const feed = useSyncExternalStore(
    useCallback((listener: () => void) => {
      feedListeners.add(listener);
      return () => feedListeners.delete(listener);
    }, []),
    () => feedSnapshot,
  );
  const subscription = useItxSubscription(subscribeAgentFeed, [], { slug: args.projectId });
  // The browser parks non-transport subscribe failures behind refresh buttons
  // and page reloads; a terminal has neither, and the TUI's failures here are
  // overwhelmingly transient (claims catching up right after project creation,
  // a Durable Object rebooting through a deploy). Retry on the old TUI's
  // linear backoff. A parked terminal-auth failure just re-reads the same
  // rejected promise — the keeper dials nothing while parked — so looping is
  // harmless there too.
  const retryAttemptRef = useRef(0);
  useEffect(() => {
    if (subscription.status === "live") {
      retryAttemptRef.current = 0;
      return;
    }
    if (subscription.status !== "error") return;
    retryAttemptRef.current += 1;
    const delay = Math.min(1_000 * retryAttemptRef.current, 15_000);
    const timer = setTimeout(subscription.refresh, delay);
    return () => clearTimeout(timer);
  }, [subscription.status, subscription.refresh]);
  const [notice, setNotice] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);

  const clearComposer = useCallback(() => {
    setComposerValue("");
    setComposerRevision((previous) => previous + 1);
  }, []);

  useKeyboard((key) => {
    if (key.name === "escape") clearComposer();
  });

  const submit = useCallback(
    (value: string) => {
      const message = value.trim();
      if (message === "") return;
      clearComposer();
      setNotice("sending…");
      connectItx(args.projectId)
        .then((itx) => {
          const agent = itx.agents.get(args.agentPath);
          return Promise.resolve(agent.message(message)).finally(() =>
            (agent as Partial<Disposable>)[Symbol.dispose]?.(),
          );
        })
        .then(() => setNotice(""))
        .catch((error: unknown) => {
          setNotice(`send failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    [clearComposer],
  );

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <ChatHeader
        title={`${args.projectId} ${args.agentPath}`}
        status={subscription.status}
        detail={subscription.error}
        notice={notice}
        eventCount={feed.eventCount}
      />
      <scrollbox
        width="100%"
        flexGrow={1}
        border
        borderStyle="single"
        borderColor={COLORS.border}
        backgroundColor={COLORS.bg}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, gap: 1 }}
      >
        {feed.items.length === 0 && feed.live == null ? (
          <text fg={COLORS.textMuted}>
            No messages yet — say something to {args.agentPath.slice("/agents/".length)}.
          </text>
        ) : null}
        {feed.items.map((item) => (
          <FeedItem key={item.id} item={item} />
        ))}
        {feed.live == null ? null : <LiveActivity activity={feed.live} />}
      </scrollbox>
      <box
        width="100%"
        height={3}
        border
        borderStyle="single"
        borderColor={COLORS.accent}
        backgroundColor={COLORS.bg}
        paddingLeft={1}
        paddingRight={1}
      >
        <input
          key={composerRevision}
          width="100%"
          value={composerValue}
          placeholder="Message the agent (Enter to send, Ctrl+C to quit)"
          focused
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={COLORS.text}
          focusedTextColor={COLORS.text}
          placeholderColor={COLORS.textMuted}
          cursorColor={COLORS.accent}
          onInput={setComposerValue}
          onSubmit={(value) => {
            if (typeof value === "string") submit(value);
          }}
        />
      </box>
    </box>
  );
}

function parseArgs(argv: string[]) {
  const baseUrl = readFlag(argv, "--base-url");
  const projectId = readFlag(argv, "--project-id");
  const agentPath = readFlag(argv, "--agent-path");

  if (baseUrl == null || projectId == null || agentPath == null) {
    throw new Error(
      "Usage: bun agent-chat-terminal.tsx --base-url <url> --project-id <prj_id> --agent-path </agents/name>",
    );
  }
  if (!agentPath.startsWith("/agents/")) {
    throw new Error(`--agent-path must start with "/agents/", got "${agentPath}".`);
  }

  return { baseUrl, projectId, agentPath };
}

function readFlag(argv: string[], flagName: string) {
  const index = argv.indexOf(flagName);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  screenMode: "alternate-screen",
  consoleMode: "disabled",
});
// TanStack Query rides OpenTUI like any other React renderer; the provider is
// here so feature code can use the shared query hooks, not just subscriptions.
const queryClient = new QueryClient();
createRoot(renderer).render(
  <QueryClientProvider client={queryClient}>
    <AgentChatApp />
  </QueryClientProvider>,
);
