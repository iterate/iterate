import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Input } from "@iterate-com/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import {
  projectAgentPresetsQueryOptions,
  projectAgentsListQueryOptions,
} from "~/lib/project-route-query.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/agents/")({
  loader: async ({ context }) => {
    const { project } = context;
    await context.queryClient.ensureQueryData(projectAgentsListQueryOptions(project.id));
    await context.queryClient.ensureQueryData(projectAgentPresetsQueryOptions(project.id));

    return {
      breadcrumb: "All",
      project,
    };
  },
  component: ProjectAgentsIndexPage,
});

type SortKey = "agentPath" | "createdAt" | "lastWokenAt";
type SortDirection = "asc" | "desc";

function ProjectAgentsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "lastWokenAt",
    direction: "desc",
  });
  const agentsQueryOptions = projectAgentsListQueryOptions(project.id);
  const { data } = useQuery({
    ...agentsQueryOptions,
    refetchInterval: 5_000,
  });
  const presetsQueryOptions = projectAgentPresetsQueryOptions(project.id);
  const { data: presetsData } = useQuery(presetsQueryOptions);
  const agents = useMemo(() => data?.agents ?? [], [data?.agents]);
  const presets = useMemo(() => presetsData?.presets ?? [], [presetsData?.presets]);
  const visibleAgents = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return agents
      .filter((agent) => {
        if (!query) return true;
        return (
          agent.agentPath.toLowerCase().includes(query) || agent.name.toLowerCase().includes(query)
        );
      })
      .toSorted((left, right) => {
        const direction = sort.direction === "asc" ? 1 : -1;
        return direction * compareAgentRows(left, right, sort.key);
      });
  }, [agents, filter, sort]);

  return (
    <section className="w-full space-y-4 p-4">
      <div className="flex justify-end">
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() =>
              void navigate({
                to: "/projects/$projectSlug/agents/new",
                params,
              })
            }
          >
            New agent
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/projects/$projectSlug/agents/new-preset",
                params,
              })
            }
          >
            New preset
          </Button>
          <EventsDebugLink
            label="Open namespace in Streams"
            namespace={project.id}
            streamPath="/"
          />
        </div>
      </div>
      <div className="flex w-full flex-col gap-2 md:flex-row">
        <Input
          className="h-9 flex-1"
          placeholder="Filter agent paths..."
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <div className="flex gap-2 md:shrink-0">
          <Button
            type="button"
            variant="outline"
            className="flex-1 md:flex-none"
            onClick={() => setFilter("")}
          >
            Reset
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Presets</h2>
          <span className="text-xs text-muted-foreground">
            {presets.length === 0
              ? "No presets configured."
              : `${presets.length} preset${presets.length === 1 ? "" : "s"} configured.`}
          </span>
        </div>
        {presets.length > 0 ? (
          <div className="space-y-2">
            {presets.map((preset) => (
              <div
                key={preset.basePath}
                className="flex items-center justify-between gap-4 rounded-md border bg-card px-3 py-2 text-sm"
              >
                <EventsStreamPathLabel path={preset.basePath} className="min-w-0" />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {preset.events.length} events
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No agents</EmptyTitle>
            <EmptyDescription>
              Project agents will appear here after they are created.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  active={sort.key === "agentPath"}
                  direction={sort.direction}
                  label="Agent path"
                  onClick={() => setSort(nextSort(sort, "agentPath"))}
                />
                <SortableHead
                  active={sort.key === "createdAt"}
                  direction={sort.direction}
                  label="Created"
                  onClick={() => setSort(nextSort(sort, "createdAt"))}
                />
                <SortableHead
                  active={sort.key === "lastWokenAt"}
                  direction={sort.direction}
                  label="Woke"
                  onClick={() => setSort(nextSort(sort, "lastWokenAt"))}
                />
                <TableHead className="w-28 text-right">Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleAgents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No agents match.
                  </TableCell>
                </TableRow>
              ) : (
                visibleAgents.map((agent) => (
                  <TableRow key={agent.name}>
                    <TableCell className="py-3">
                      <Link
                        className="block min-w-0 rounded-sm text-sm font-medium hover:underline"
                        to="/projects/$projectSlug/agents/streams/$"
                        params={{
                          projectSlug: params.projectSlug,
                          _splat: agent.agentPath,
                        }}
                      >
                        <EventsStreamPathLabel path={agent.agentPath} className="min-w-0" />
                      </Link>
                    </TableCell>
                    <TableCell className="w-40 text-muted-foreground">
                      {formatRelativeTime(agent.createdAt)}
                    </TableCell>
                    <TableCell className="w-40 text-muted-foreground">
                      {formatRelativeTime(agent.lastWokenAt)}
                    </TableCell>
                    <TableCell className="w-28 text-right">
                      <EventsDebugLink
                        label="Open"
                        namespace={project.id}
                        streamPath={agent.agentPath}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function SortableHead(input: {
  active: boolean;
  direction: SortDirection;
  label: string;
  onClick: () => void;
}) {
  return (
    <TableHead>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-8 px-2"
        onClick={input.onClick}
      >
        {input.label}
        <span className="text-[10px] text-muted-foreground">
          {input.active ? input.direction : "sort"}
        </span>
      </Button>
    </TableHead>
  );
}

function nextSort(current: { key: SortKey; direction: SortDirection }, key: SortKey) {
  if (current.key !== key) return { key, direction: "asc" as const };
  return { key, direction: current.direction === "asc" ? ("desc" as const) : ("asc" as const) };
}

function compareAgentRows(
  left: { agentPath: string; createdAt: string; lastWokenAt: string },
  right: { agentPath: string; createdAt: string; lastWokenAt: string },
  key: SortKey,
) {
  if (key === "agentPath") return left.agentPath.localeCompare(right.agentPath);
  return new Date(left[key]).getTime() - new Date(right[key]).getTime();
}

function formatRelativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units = [
    { label: "year", seconds: 31_536_000 },
    { label: "month", seconds: 2_592_000 },
    { label: "day", seconds: 86_400 },
    { label: "hour", seconds: 3_600 },
    { label: "minute", seconds: 60 },
  ] as const;
  const unit = units.find((unit) => absoluteSeconds >= unit.seconds);
  if (!unit) return seconds < 0 ? "in a few seconds" : "just now";

  const count = Math.round(absoluteSeconds / unit.seconds);
  const suffix = count === 1 ? unit.label : `${unit.label}s`;
  return seconds < 0 ? `in ${count} ${suffix}` : `${count} ${suffix} ago`;
}
