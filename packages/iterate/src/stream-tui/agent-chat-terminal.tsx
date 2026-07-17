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
import { userInfo } from "node:os";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { QueryClientProvider, QueryErrorResetBoundary, useMutation } from "@tanstack/react-query";
import {
  configureIterateSession,
  connectItx,
  createIterateQueryClient,
  ProjectScope,
  useItxQuery,
  useItxSubscription,
  type Itx,
} from "../itx/itx-react.ts";
import {
  ONBOARDING_AGENT_PATH,
  onboardingAgentCreateInput,
} from "../../../../apps/os/src/lib/onboarding-agent.ts";
import { sendAgentMessage } from "./agent-message-command.ts";
import { createAgentFeedModel, type AgentFeedSnapshot } from "./agent-feed-model.ts";
import { readAgentFeedHistory } from "./agent-feed-query.ts";
import { resolveItxAuth } from "./itx-auth.ts";
import { ChatHeader, FeedItem, LiveActivity } from "./chat-view.tsx";
import { COLORS } from "./chat-colors.ts";
import { createChatComputerSharing, launchUseMyComputerProvider } from "./chat-computer-sharing.ts";
import { computerCapabilityName, parseChatSlashCommand } from "./chat-slash-command.ts";
import { LoadingTerminal, TerminalErrorBoundary } from "./terminal-shell.tsx";
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("iterate chat requires an interactive terminal.");
}

const args = parseArgs(process.argv.slice(2));
const computerName = computerCapabilityName(userInfo().username);
const computerSharing = createChatComputerSharing({
  name: computerName,
  launch: () =>
    launchUseMyComputerProvider({
      bearerTokenCameFromStoredSession: process.env.ITERATE_CHAT_BEARER_FROM_STORED_SESSION === "1",
      cliPath: args.cliPath,
      configName: args.configName,
      environment: process.env,
      name: computerName,
      projectId: args.projectId,
    }),
});
process.on("exit", () => computerSharing[Symbol.dispose]());
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
  const computerShare = useSyncExternalStore(computerSharing.subscribe, computerSharing.snapshot);
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

  /**
   * Establish the live agent feed on the shared socket: ensure the agent
   * exists, then subscribe from the query-seeded model's resume cursor. The
   * onboarding agent is deliberately not born at project bootstrap (a birth
   * costs a real LLM turn); opening either browser or terminal chat births it
   * with the same explicit batch. Recovery rereads the current cursor and the
   * model folds replay overlap out by offset.
   */
  const subscribeAgentFeed = useCallback(
    (itx: Itx) => openAgentFeedSubscription({ itx, model, publishFeed }),
    [model, publishFeed],
  );
  const subscription = useItxSubscription(subscribeAgentFeed, [model], {
    slug: args.projectId,
  });
  // oxlint-disable react-doctor/query-mutation-missing-invalidation -- History is only the startup seed; the replay-capable subscription is the live authority. Writing or refetching the mutation result here can advance the model past delayed events.
  const {
    mutate: sendMessage,
    isPending: messageIsPending,
    error: messageError,
  } = useMutation({
    mutationFn: async (message: string) => {
      const itx = await connectItx(args.projectId);
      const agent = itx.agents.get(args.agentPath);
      try {
        await sendAgentMessage(agent, message);
      } finally {
        (agent as Partial<Disposable>)[Symbol.dispose]?.();
      }
    },
  });
  // oxlint-enable react-doctor/query-mutation-missing-invalidation
  const messageNotice = messageIsPending
    ? "sending…"
    : messageError != null
      ? `send failed: ${messageError instanceof Error ? messageError.message : String(messageError)}`
      : "";
  const notice = [messageNotice, subscription.status === "error" ? "Ctrl+R to retry" : ""]
    .filter(Boolean)
    .join(" · ");
  const [composerValue, setComposerValue] = useState("");
  const [composerRevision, setComposerRevision] = useState(0);

  const clearComposer = useCallback(() => {
    setComposerValue("");
    setComposerRevision((previous) => previous + 1);
  }, []);

  useKeyboard((key) => {
    if (key.name === "escape") clearComposer();
    if (key.ctrl && key.name === "r" && subscription.status === "error") {
      subscription.refresh();
    }
  });

  const submit = useCallback(
    (value: string) => {
      const message = value.trim();
      if (message === "") return;
      clearComposer();
      if (parseChatSlashCommand(message)?.kind === "use-my-computer") {
        computerSharing.start();
        return;
      }
      sendMessage(message);
    },
    [clearComposer, sendMessage],
  );

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={COLORS.bg}>
      <ChatHeader
        title={`${args.projectId} ${args.agentPath}`}
        status={subscription.status}
        detail={subscription.error}
        notice={[notice, computerShare.notice].filter(Boolean).join(" · ")}
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
  const cliPath = readFlag(argv, "--cli-path");
  const configName = readFlag(argv, "--config-name");

  if (
    baseUrl == null ||
    projectId == null ||
    agentPath == null ||
    cliPath == null ||
    configName == null
  ) {
    throw new Error(
      "Usage: bun agent-chat-terminal.tsx --base-url <url> --project-id <prj_id> --agent-path </agents/name> --cli-path <path> --config-name <name>",
    );
  }
  if (!agentPath.startsWith("/agents/")) {
    throw new Error(`--agent-path must start with "/agents/", got "${agentPath}".`);
  }

  return { baseUrl, projectId, agentPath, cliPath, configName };
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
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <TerminalErrorBoundary onReset={reset}>
          <ProjectScope slug={args.projectId}>
            <Suspense fallback={<LoadingTerminal />}>
              <AgentChatApp />
            </Suspense>
          </ProjectScope>
        </TerminalErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  </QueryClientProvider>,
);
