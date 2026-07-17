#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
// oxlint-disable react/only-export-components -- CLI entrypoint, not a Vite Fast Refresh module.
/**
 * React/OpenTUI terminal chat with one project agent.
 *
 * The data layer is the SAME client stack the web app renders from: the
 * one-socket session keeper (`iterate/client`, pointed at the deployment via
 * `configureIterateSession`) and the shared React hooks (`iterate/react` —
 * `useItxQuery` seeds durable history and `useItxSubscription` owns reconnect,
 * watchdog, and re-subscribe recovery), folding stream events through the
 * shared agent-ui reducer (@iterate-com/ui). Sends use TanStack Query's
 * mutation lifecycle and `agent.message` on the same socket. This file owns
 * the app shell and terminal runtime state; the presentational components live
 * in ./chat-view.tsx. OpenTUI is just another React renderer, so the browser's
 * query policy and hooks run here unchanged.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  configureIterateSession,
  connectItx,
  createIterateQueryClient,
  ProjectScope,
  useItxQuery,
  useItxSubscription,
  type Itx,
} from "../itx/itx-react.ts";
import type { StreamEvent } from "../itx-api.generated.ts";
import {
  ONBOARDING_AGENT_PATH,
  onboardingAgentCreateInput,
} from "../../../../apps/os/src/lib/onboarding-agent.ts";
import { createAgentFeedModel, type AgentFeedSnapshot } from "./agent-feed-model.ts";
import { mergeAgentFeedHistory, readAgentFeedHistory } from "./agent-feed-query.ts";
import { resolveItxAuth } from "./itx-auth.ts";
import { ChatHeader, FeedItem, LiveActivity } from "./chat-view.tsx";
import { COLORS } from "./chat-colors.ts";
import { LoadingTerminal, TerminalErrorBoundary } from "./terminal-shell.tsx";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("iterate chat requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
const historyQueryKey = ["agent-feed-history", args.projectId, args.agentPath] as const;

// One keeper socket for the whole process — the TUI's equivalent of the
// browser tab. Everything below (subscription, sends) rides it.
configureIterateSession({
  baseUrl: args.baseUrl,
  credentials: resolveItxAuth({ configName: process.env.ITERATE_CONFIG_NAME }),
});

// ---------------------------------------------------------------------------
// The app shell
// ---------------------------------------------------------------------------

async function openAgentFeedSubscription(input: {
  itx: Itx;
  model: ReturnType<typeof createAgentFeedModel>;
  publishFeed: () => void;
  recordDurableEvents: (events: readonly StreamEvent[]) => void;
}) {
  // One agent path stub per (re)subscribe cycle, released once the returned
  // subscription handle exists. useItxSubscription owns and releases that
  // handle on dependency changes, reconnect, and unmount.
  const agent = input.itx.agents.get(args.agentPath);
  try {
    const snapshot = await agent.processor.snapshot();
    if (snapshot.state.birthCertificate === null) {
      await agent.create(
        args.agentPath === ONBOARDING_AGENT_PATH ? onboardingAgentCreateInput(args.projectId) : {},
      );
    }
    return await agent.stream.subscribe({
      processEventBatch: (batch) => {
        input.recordDurableEvents(batch.events);
        if (input.model.applyEvents(batch.events)) input.publishFeed();
      },
      replayAfterOffset: input.model.snapshot().lastOffset,
      subscriber: { description: "iterate chat TUI" },
    });
  } finally {
    (agent as Partial<Disposable>)[Symbol.dispose]?.();
  }
}

function AgentChatApp() {
  // The immutable/durable half is a finite TanStack query, exactly like a
  // browser route read. The live subscription starts at that query's cursor,
  // closes the read→subscribe race with replay, then owns the tail.
  const history = useItxQuery({
    key: historyQueryKey,
    query: (itx) => readAgentFeedHistory(itx, args.agentPath),
  });
  const [model] = useState(() => {
    const next = createAgentFeedModel();
    next.applyEvents(history);
    return next;
  });
  const [feed, setFeed] = useState<AgentFeedSnapshot>(() => model.snapshot());
  useEffect(() => {
    if (model.applyEvents(history)) setFeed(model.snapshot());
  }, [history, model]);
  const publishFeed = useCallback(() => setFeed(model.snapshot()), [model]);
  const queryClient = useQueryClient();
  const recordDurableEvents = useCallback(
    (events: readonly StreamEvent[]) => {
      queryClient.setQueryData<StreamEvent[]>(["itx", ...historyQueryKey], (current = []) =>
        mergeAgentFeedHistory(current, events),
      );
    },
    [queryClient],
  );

  /**
   * Establish the live agent feed on the shared socket: ensure the agent
   * exists, then subscribe from the query-seeded model's resume cursor. The
   * onboarding agent is deliberately not born at project bootstrap (a birth
   * costs a real LLM turn); opening either browser or terminal chat births it
   * with the same explicit batch. Recovery rereads the current cursor and the
   * model folds replay overlap out by offset.
   */
  const subscribeAgentFeed = useCallback(
    (itx: Itx) => openAgentFeedSubscription({ itx, model, publishFeed, recordDurableEvents }),
    [model, publishFeed, recordDurableEvents],
  );
  const subscription = useItxSubscription(subscribeAgentFeed, [model], {
    slug: args.projectId,
  });
  const sendMessage = useMutation({
    mutationFn: async (message: string) => {
      const itx = await connectItx(args.projectId);
      const agent = itx.agents.get(args.agentPath);
      try {
        return await agent.message(message);
      } finally {
        (agent as Partial<Disposable>)[Symbol.dispose]?.();
      }
    },
    // The mutation response and subscription can race. Fold both through the
    // same offset-aware cache merge; the live model has the same dedupe rule.
    onSuccess: (event) => {
      queryClient.setQueryData<StreamEvent[]>(["itx", ...historyQueryKey], (current = []) =>
        mergeAgentFeedHistory(current, [event]),
      );
    },
  });
  const notice = sendMessage.isPending
    ? "sending…"
    : sendMessage.error != null
      ? `send failed: ${sendMessage.error instanceof Error ? sendMessage.error.message : String(sendMessage.error)}`
      : "";
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
      sendMessage.mutate(message);
    },
    [clearComposer, sendMessage],
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
const queryClient = createIterateQueryClient();
createRoot(renderer).render(
  <QueryClientProvider client={queryClient}>
    <TerminalErrorBoundary>
      <ProjectScope slug={args.projectId}>
        <Suspense fallback={<LoadingTerminal />}>
          <AgentChatApp />
        </Suspense>
      </ProjectScope>
    </TerminalErrorBoundary>
  </QueryClientProvider>,
);
