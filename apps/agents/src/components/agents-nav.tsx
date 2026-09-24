// The sidebar's body for this app (the frame around it is packages/ui's AppShell): "New agent" and
// the project's agents, most recently active first — each titled by the first thing a person said
// to it, its path beneath, and a dot while it runs or waits on a person (agent-summary.ts, kept live
// by use-agent-summaries.ts). Pinned agents sit in their own list above, pins kept per project in
// this browser. An agent IS its path (`/agents/...`); "New agent" births one at a generated path
// and the page opens it — no name to type.
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { BotIcon, PinIcon, SquarePenIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  countActiveOrWaiting,
  orderAgents,
  type AgentRow,
  type AgentStatus,
} from "../lib/agent-summary.ts";
import type { AgentLiveSummary } from "../lib/use-agent-summaries.ts";
import { usePinnedAgents } from "../lib/use-pinned-agents.ts";

export function AgentsNav({
  project,
  slug,
  agents,
  summaries,
  agent,
  onCreate,
  installed,
}: {
  /** the project's id — pins are kept under it */
  project: string;
  /** the project's slug — its URL (`/projects/<slug>`) */
  slug: string;
  installed: boolean;
  agents: { path: string; createdAt: string }[];
  /** each agent's live summary by path; absent while its subscription connects */
  summaries: Readonly<Record<string, AgentLiveSummary>>;
  agent: string | undefined;
  /** Births an agent at a fresh path; the page navigates to it once it exists. */
  onCreate: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const { pinned, togglePinned } = usePinnedAgents(project);
  const rows = useMemo<AgentRow[]>(
    () =>
      agents.map(({ path, createdAt }) => {
        const live = summaries[path];
        return { path, createdAt, summary: live?.kind === "live" ? live.summary : undefined };
      }),
    [agents, summaries],
  );
  const ordered = useMemo(() => orderAgents(rows, pinned), [rows, pinned]);
  const busy = countActiveOrWaiting(rows);
  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      await onCreate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }
  const renderRow = (row: AgentRow) => (
    <AgentsNavRow
      key={row.path}
      slug={slug}
      row={row}
      unavailable={summaries[row.path]?.kind === "unavailable"}
      active={row.path === agent}
      pinned={pinned.has(row.path)}
      onTogglePinned={() => togglePinned(row.path)}
    />
  );
  return (
    <>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                onClick={() => void create()}
                disabled={creating}
                tooltip={installed ? "New agent" : "Install agents"}
              >
                <SquarePenIcon />
                <span>
                  {creating
                    ? installed
                      ? "Creating…"
                      : "Installing…"
                    : installed
                      ? "New agent"
                      : "Install agents"}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {ordered.pinned.length > 0 ? (
        <SidebarGroup>
          <SidebarGroupLabel>Pinned</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{ordered.pinned.map(renderRow)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      <SidebarGroup>
        <SidebarGroupLabel className="gap-2">
          <span>Agents</span>
          {busy > 0 ? (
            <span
              className="ml-auto rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
              data-agents-busy={busy}
            >
              {busy} active or waiting
            </span>
          ) : null}
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {agents.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No agents yet.</p>
            ) : null}
            {ordered.recent.map(renderRow)}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "Running",
  waiting: "Paused — waiting for you",
  idle: "Idle",
};

function AgentsNavRow({
  slug,
  row,
  unavailable,
  active,
  pinned,
  onTogglePinned,
}: {
  slug: string;
  row: AgentRow;
  unavailable: boolean;
  active: boolean;
  pinned: boolean;
  onTogglePinned: () => void;
}) {
  const status = row.summary?.status;
  const title = row.summary?.title ?? row.path.split("/").filter(Boolean).at(-1) ?? row.path;
  const tooltip = [
    row.path,
    status ? STATUS_LABEL[status] : unavailable ? "Live status unavailable" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SidebarMenuItem data-agent-path={row.path} data-agent-status={status || "unknown"}>
      <SidebarMenuButton
        size="lg"
        isActive={active}
        tooltip={tooltip}
        render={<Link to="/projects/$slug" params={{ slug }} search={{ agent: row.path }} />}
      >
        <span className="relative flex shrink-0">
          <BotIcon />
          {status === "running" || status === "waiting" ? (
            <span
              aria-label={STATUS_LABEL[status]}
              className={cn(
                "absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-sidebar",
                status === "running" && "bg-emerald-500 motion-safe:animate-pulse",
                status === "waiting" && "bg-amber-500",
              )}
            />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">{title}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{row.path}</span>
        </span>
      </SidebarMenuButton>
      <button
        type="button"
        data-sidebar="menu-action"
        aria-label={pinned ? "Unpin agent" : "Pin agent"}
        aria-pressed={pinned}
        onClick={onTogglePinned}
        className={cn(
          "absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:hidden [&>svg]:size-3.5",
          // touch has no hover: the action shows there; a pointer reveals it on the row
          !pinned &&
            "md:opacity-0 md:group-hover/menu-item:opacity-100 md:focus-visible:opacity-100",
        )}
      >
        <PinIcon className={cn(pinned && "fill-current")} />
      </button>
    </SidebarMenuItem>
  );
}
