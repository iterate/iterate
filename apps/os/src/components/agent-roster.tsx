import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Circle } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@iterate-com/ui/components/sidebar";
import { cn } from "@iterate-com/ui/lib/utils";
import { useLiveState } from "~/itx/itx-react.tsx";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";

type RosterRow = {
  path: string;
  state: "busy" | "blocked" | "idle";
  title: string;
  /** The expandable secondary line: what the agent is doing right now
   * (while busy or blocked) or its standing note. */
  detail: string | undefined;
  lastActivityAt: string;
};

/**
 * The project's agents roster, live from the `agents` slice of
 * `itx.liveState` (each agent's merged status record, folded from its own
 * status-changed patches; the server pushes a snapshot then minimal diffs —
 * no polling anywhere). ONE subscription per mounted component, and a
 * STABLE-slice selector per the useLiveState contract — the sort/shape work
 * happens in the downstream useMemo. Recency is the row's own `updatedAt`:
 * every turn flips busy at trigger and settle, so the last status patch IS
 * the agent's last activity. Subscribed through `address` — the sidebar
 * lives in the app shell, outside the project's ItxProvider — so it never
 * suspends and paints when the project socket connects.
 */
function useAgentRoster(projectId: string): RosterRow[] {
  const roster = useLiveState(
    (itx) => itx.liveState,
    (state) => state.agents,
    [projectId],
    { address: { projectId } },
  );
  return useMemo(() => {
    if (roster.value === undefined) return [];
    return Object.values(roster.value)
      .map((row): RosterRow => {
        const state =
          row.status.busy === true ? "busy" : row.status.blocked === true ? "blocked" : "idle";
        const doing =
          row.status.shortStatus ??
          (state === "busy"
            ? row.status.phase === "script"
              ? "running a script"
              : "making an LLM request"
            : state === "blocked"
              ? "waiting for input"
              : undefined);
        return {
          path: row.path,
          state,
          title: row.status.title ?? agentPathLabel(row.path),
          detail: state === "idle" ? row.status.note : `is ${doing}…`,
          lastActivityAt: row.updatedAt,
        };
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }, [roster.value]);
}

/**
 * The agents roster in the project sidebar, newest activity first: a live
 * busy dot, the agent's title, and its expandable status line per agent.
 * Sits in the nav content after the stream links (its own leading divider),
 * so a long list scrolls naturally with the sidebar. Hidden while the
 * sidebar is collapsed to icons, and absent entirely — divider included —
 * until any agent has announced status.
 */
export function SidebarRecentAgents({
  projectId,
  projectSlug,
}: {
  projectId: string;
  projectSlug: string;
}) {
  const rows = useAgentRoster(projectId);
  if (rows.length === 0) return null;
  return (
    <>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupContent>
          <SidebarMenu>
            {rows.map((row) => (
              <AgentRosterMenuItem key={row.path} projectSlug={projectSlug} row={row} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

/** The same roster as a plain list for the agents page side panel — every agent, newest first. */
export function AgentRosterList({
  projectId,
  projectSlug,
}: {
  projectId: string;
  projectSlug: string;
}) {
  const rows = useAgentRoster(projectId);
  if (rows.length === 0) return null;
  return (
    <SidebarMenu>
      {rows.map((row) => (
        <AgentRosterMenuItem key={row.path} projectSlug={projectSlug} row={row} />
      ))}
    </SidebarMenu>
  );
}

function AgentRosterMenuItem({ projectSlug, row }: { projectSlug: string; row: RosterRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto py-1.5 pr-7"
        tooltip={row.title}
        render={<Link {...linkOptionsForStreamPath(projectSlug, row.path)} />}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Circle
              aria-label={row.state}
              className={cn(
                "size-2 shrink-0",
                row.state === "busy"
                  ? "animate-pulse fill-green-500 text-green-500"
                  : row.state === "blocked"
                    ? "fill-amber-500 text-amber-500"
                    : "fill-muted-foreground/40 text-muted-foreground/40",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
          </div>
          {row.detail === undefined ? null : (
            <span className={cn("text-xs text-muted-foreground", expanded ? "" : "truncate")}>
              {row.detail}
            </span>
          )}
        </div>
      </SidebarMenuButton>
      {row.detail === undefined ? null : (
        <SidebarMenuAction
          aria-label={expanded ? "Collapse status" : "Expand status"}
          onClick={() => setExpanded((value) => !value)}
          showOnHover
        >
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
}

/** "/agents/slack/nustom/c123/ts-1" → "slack/nustom/c123/ts-1" — the path sans its /agents/ prefix. */
function agentPathLabel(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 1 ? segments.slice(1).join("/") : path;
}
