import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { SendHorizontalIcon, SquareIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { AgentFeedItemRow } from "@iterate-com/ui/components/agent-feed/agent-feed-item";
import {
  AgentLiveActivity,
  QueuedMessagesPanel,
} from "@iterate-com/ui/components/agent-feed/agent-live-activity";
import {
  isAgentRuntimeVisiblyActive,
  type AgentUiMessageItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { FeedLiveState } from "iterate/client";
import { withDocsProject } from "../lib/docs-client.ts";
import { useAgentFeed } from "../lib/use-agent-feed.ts";
import { WorkspacePresence } from "./workspace-presence.tsx";

/** The runtime shape the live snapshot reports; all zeros when it reports none. */
type AgentRuntimeCounts = NonNullable<FeedLiveState["runtimeChange"]>["runtime"];

const IDLE_RUNTIME: AgentRuntimeCounts = {
  triggers: { pending: 0, runnable: 0 },
  llmRequests: { scheduled: 0, requested: 0, started: 0 },
  runningScripts: 0,
};

/**
 * The workspace's agent, beside the editor: the same feed rows the OS
 * renders, over the agent's published items and live snapshot, plus a
 * composer. Send appends a user message; while the agent works the same
 * button interrupts it, the way the OS composer does.
 */
export function AgentFeedPane({ agentPath }: { agentPath: string }) {
  const feed = useAgentFeed(agentPath);
  const [toggledIds, setToggledIds] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((id: string) => {
    setToggledIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const runtime = feed.live?.runtimeChange?.runtime ?? IDLE_RUNTIME;
  const working = isAgentRuntimeVisiblyActive(runtime);
  const liveActivity = feed.live?.agent?.live ?? null;
  const queued = (feed.live?.agent?.queuedUserMessages ?? []) as AgentUiMessageItem[];
  const viewers = (feed.live?.agent?.presence ?? [])
    .filter((entry) => entry.connected && entry.connectionKind === "session" && entry.user)
    .map((entry) => ({
      clientId: entry.connectionKey,
      name: entry.user?.name ?? entry.user?.email ?? "?",
    }));

  // A chat tail: stay pinned to the newest row unless the reader scrolled up.
  useEffect(() => {
    const node = scroller.current;
    if (node !== null && pinned.current) node.scrollTop = node.scrollHeight;
  }, [feed.items, liveActivity, queued.length]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (content === "" || sending) return;
    setSending(true);
    setActionError(null);
    void withDocsProject(async (project) => (await project.agent(agentPath)).message(content))
      .then(() => setDraft(""))
      .catch((cause: unknown) =>
        setActionError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setSending(false));
  };

  // Cancellation is a property of new input, never a free-standing command:
  // the agent processor settles the open request as cancelled when an
  // interrupting context item lands. The USER actor classifies the stop as
  // an external trigger; a developer item stays out of the chat feed.
  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    setActionError(null);
    try {
      await withDocsProject(async (project) =>
        (await project.agent(agentPath)).append({
          type: "events.iterate.com/agents/context-added",
          payload: {
            role: "developer",
            content: "The user interrupted the in-progress response from the workspace feed.",
            actor: { type: "user", origin: "web" },
            llmRequestPolicy: { behaviour: "interrupt-current-request" },
          },
        }),
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInterrupting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-feed-pane">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {agentPath}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <WorkspacePresence self={null} clients={viewers} />
          <span className="font-mono text-[11px] text-muted-foreground">
            {feed.error ??
              (feed.connectionStatus === "live"
                ? working
                  ? "working"
                  : "live"
                : feed.connectionStatus)}
          </span>
        </span>
      </div>
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {!feed.ready ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Opening the agent…
          </p>
        ) : feed.items.length === 0 && liveActivity === null ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Say what you need; the agent reads and edits this workspace.
          </p>
        ) : null}
        {feed.items.map((item) => (
          <AgentFeedItemRow key={item.id} item={item} toggledIds={toggledIds} onToggle={onToggle} />
        ))}
        {liveActivity === null ? null : (
          <AgentLiveActivity
            live={liveActivity}
            runtime={runtime}
            toggledIds={toggledIds}
            onToggle={onToggle}
          />
        )}
      </div>
      <div className="shrink-0 border-t px-3 pt-3 pb-3">
        <QueuedMessagesPanel
          messages={queued}
          isInterrupting={interrupting}
          onInterrupt={interrupt}
        />
        <form onSubmit={send} className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            aria-label="Message the agent"
            placeholder="Message the agent…"
            disabled={!feed.ready}
            rows={2}
            className="min-h-0 flex-1 resize-none text-sm"
          />
          {working ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 w-9 px-0"
              aria-label="Stop the agent"
              disabled={interrupting}
              onClick={() => void interrupt()}
            >
              {interrupting ? (
                <Spinner className="size-4" />
              ) : (
                <SquareIcon aria-hidden className="size-3.5" />
              )}
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Send message"
              disabled={!feed.ready || sending || draft.trim() === ""}
            >
              {sending ? (
                <Spinner className="size-4" />
              ) : (
                <SendHorizontalIcon aria-hidden className="size-4" />
              )}
            </Button>
          )}
        </form>
        {actionError !== null && <p className="mt-1 text-xs text-red-700">{actionError}</p>}
      </div>
    </div>
  );
}
