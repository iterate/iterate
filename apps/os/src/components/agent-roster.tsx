import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  Github,
  Globe,
  Mail,
  Send,
  Slack,
  type LucideIcon,
} from "lucide-react";
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
import { agentPathIcon, agentPathLabel } from "~/lib/agent-roster-labels.ts";
import { agentBusyPhaseLabel } from "~/lib/feed-format.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { linkOptionsForStreamPath } from "~/lib/stream-routes.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

/** Coarse tick for relative "ago" labels in the sidebar (matches stream switcher). */
const CLOCK_TICK_MS = 15_000;

type RosterRow = {
  path: string;
  state: "busy" | "blocked" | "idle";
  /** A builtin icon name or an https image URL (see AgentStatusRecord.icon). */
  icon: string | undefined;
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
        const pathLabel = agentPathLabel(row.path);
        const doing =
          row.status.shortStatus ??
          (state === "busy"
            ? agentBusyPhaseLabel(row.status.phase)
            : state === "blocked"
              ? "waiting for input"
              : undefined);
        return {
          path: row.path,
          state,
          icon: row.status.icon ?? agentPathIcon(row.path),
          title: row.status.title ?? pathLabel.title,
          detail: state === "idle" ? (row.status.note ?? pathLabel.subtitle) : `is ${doing}…`,
          lastActivityAt: row.updatedAt,
        };
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }, [roster.value]);
}

/**
 * The agents roster in the project sidebar, newest activity first: a live
 * busy dot, the agent's title, last activity, and its expandable status line.
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
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  if (rows.length === 0) return null;
  return (
    <>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupContent>
          <SidebarMenu>
            {rows.map((row) => (
              <AgentRosterMenuItem
                key={row.path}
                nowMs={nowMs}
                projectSlug={projectSlug}
                row={row}
              />
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
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  if (rows.length === 0) return null;
  return (
    <SidebarMenu>
      {rows.map((row) => (
        <AgentRosterMenuItem key={row.path} nowMs={nowMs} projectSlug={projectSlug} row={row} />
      ))}
    </SidebarMenu>
  );
}

function AgentRosterMenuItem({
  nowMs,
  projectSlug,
  row,
}: {
  nowMs: number;
  projectSlug: string;
  row: RosterRow;
}) {
  const [expanded, setExpanded] = useState(false);
  const ago = formatTimeAgo(row.lastActivityAt, nowMs);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-auto py-1 pr-7 text-[12px] leading-tight"
        tooltip={`${row.title} · ${ago}`}
        render={<Link {...linkOptionsForStreamPath(projectSlug, row.path)} />}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Circle
              aria-label={row.state}
              className={cn(
                "size-1.5 shrink-0",
                row.state === "busy"
                  ? "animate-pulse fill-green-500 text-green-500"
                  : row.state === "blocked"
                    ? "fill-amber-500 text-amber-500"
                    : "fill-muted-foreground/40 text-muted-foreground/40",
              )}
            />
            <RosterIcon icon={row.icon} />
            <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
            <span
              className="shrink-0 text-[10px] tabular-nums text-muted-foreground/80"
              title={row.lastActivityAt}
            >
              {ago}
            </span>
          </div>
          {row.detail === undefined ? null : (
            <span
              className={cn(
                "pl-3.5 text-[11px] leading-snug text-muted-foreground",
                expanded ? "" : "truncate",
              )}
            >
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

const BUILTIN_ROSTER_ICONS: Record<string, LucideIcon> = {
  email: Mail,
  github: Github,
  slack: Slack,
  telegram: Send,
  web: Globe,
};

/** The agent's identity mark: a builtin lucide icon by name, an https image
 * URL as a tiny img, or nothing (unknown names render nothing rather than a
 * broken glyph). */
function RosterIcon({ icon }: { icon: string | undefined }) {
  if (icon === undefined) return null;
  const Builtin = BUILTIN_ROSTER_ICONS[icon];
  if (Builtin !== undefined) {
    return <Builtin aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (icon.startsWith("https://")) {
    return <img alt="" src={icon} className="size-3 shrink-0 rounded-sm object-cover" />;
  }
  return null;
}
