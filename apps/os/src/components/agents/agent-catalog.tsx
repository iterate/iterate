import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { Input } from "@iterate-com/ui/components/input";
import { Agent } from "./agent.tsx";
import { buildAgentForest, flattenVisibleAgentRows, pinnedAgentShortcuts } from "./agent-tree.ts";
import type { AgentRecord } from "~/domains/agents/agent-presence.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const CLOCK_TICK_MS = 15_000;
const PINNED_CATALOG_LIMIT = 12;

export function AgentCatalog({
  agents,
  onOpen,
  onTogglePinned,
  projectSlug,
}: {
  agents: Record<string, AgentRecord>;
  onOpen: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<void>;
  projectSlug: string;
}) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const nowMs = useTickingNowMs(CLOCK_TICK_MS);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const forest = useMemo(() => buildAgentForest(agents), [agents]);
  const pinned = useMemo(() => pinnedAgentShortcuts(forest), [forest]);
  const visiblePinned = pinned.slice(0, PINNED_CATALOG_LIMIT);
  const rows = useMemo(
    () => flattenVisibleAgentRows(forest, expandedPaths, query),
    [expandedPaths, forest, query],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 142,
    overscan: 6,
    scrollMargin,
  });

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    const listElement = listRef.current;
    if (scrollElement === null || contentElement === null || listElement === null) return;

    const measure = () => {
      const nextMargin = Math.max(
        0,
        listElement.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
      );
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin));
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(contentElement);
    return () => observer.disconnect();
  }, [agents, query, visiblePinned.length]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Agents catalog">
      <div className="shrink-0 border-b bg-background/95 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
              <p className="text-sm text-muted-foreground">
                Live work, dependencies, and child agents across this project.
              </p>
            </div>
            <Button
              nativeButton={false}
              size="sm"
              render={
                <Link to="/projects/$projectSlug/agents/new" params={{ projectSlug }} search={{}} />
              }
            >
              New agent
            </Button>
          </div>
          <div className="relative max-w-xl">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, activity, summary, path, or binding"
              className="pl-8"
              aria-label="Search agents"
            />
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div ref={contentRef} className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          {pinned.length > 0 && query.trim() === "" ? (
            <section aria-labelledby="pinned-agents-heading" className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 id="pinned-agents-heading" className="text-sm font-semibold">
                  Pinned
                </h2>
                <span className="text-xs text-muted-foreground">{pinned.length}</span>
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                {visiblePinned.map((node) => (
                  <Agent
                    key={`pinned:${node.agent.path}`}
                    agent={node.agent}
                    variant="catalog"
                    nowMs={nowMs}
                    shortcut
                    tree={{ ...node, expanded: false }}
                    actions={{
                      onOpen: () => onOpen(node.agent.path),
                      onTogglePinned: () => onTogglePinned(node.agent),
                    }}
                  />
                ))}
              </div>
              {pinned.length > visiblePinned.length ? (
                <p className="text-xs text-muted-foreground">
                  Showing {visiblePinned.length} of {pinned.length} pinned agents. Every pinned
                  agent remains in the searchable catalog below.
                </p>
              ) : null}
            </section>
          ) : null}

          <section ref={listRef} aria-labelledby="all-agents-heading" className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="all-agents-heading" className="text-sm font-semibold">
                {query.trim() === "" ? "All agents" : "Matches"}
              </h2>
              <span className="text-xs text-muted-foreground">{rows.length}</span>
            </div>
            {rows.length === 0 ? (
              <Empty className="min-h-52 rounded-lg border">
                <EmptyHeader>
                  <EmptyTitle>
                    {Object.keys(agents).length === 0 ? "No agents yet" : "No matches"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {Object.keys(agents).length === 0
                      ? "Create an agent to start a durable conversation."
                      : "Try a title, activity, path, or integration name."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (row === undefined) return null;
                  const node = row.node;
                  const expanded = query.trim() !== "" || expandedPaths.has(node.agent.path);
                  return (
                    <li
                      key={node.agent.path}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      className="absolute left-0 top-0 w-full pb-2"
                      style={{
                        transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        paddingLeft: `${Math.min(row.depth, 4) * 18}px`,
                      }}
                    >
                      <Agent
                        agent={node.agent}
                        variant="catalog"
                        nowMs={nowMs}
                        tree={{ ...node, expanded }}
                        actions={{
                          onOpen: () => onOpen(node.agent.path),
                          onTogglePinned: () => onTogglePinned(node.agent),
                          onToggleChildren: () => toggleExpanded(node.agent.path),
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
