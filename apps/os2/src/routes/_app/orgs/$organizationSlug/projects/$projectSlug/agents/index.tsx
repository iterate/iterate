import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { EventsDebugLink } from "~/components/events-debug-link.tsx";
import {
  defaultAgentSystemPrompt,
  normalizeAgentPresetBasePath,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import { agentPathFromInput, agentPathToSplat } from "~/lib/agent-links.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/agents/")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.agents.list.queryOptions({ input: { projectSlugOrId: project.id } }),
      staleTime: 10_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.agents.listPresets.queryOptions({ input: { projectSlugOrId: project.id } }),
      staleTime: 10_000,
    });

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
  const queryClient = useQueryClient();
  const { project } = Route.useLoaderData();
  const [filter, setFilter] = useState("");
  const [presetBasePath, setPresetBasePath] = useState("/agents");
  const [presetProvider, setPresetProvider] = useState<AgentLlmProvider>("openai-ws");
  const [presetModel, setPresetModel] = useState("gpt-5.5");
  const [presetSystemPrompt, setPresetSystemPrompt] = useState(defaultAgentSystemPrompt());
  const [presetRunOpts, setPresetRunOpts] = useState('{"gateway":{"id":"default"}}');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "lastWokenAt",
    direction: "desc",
  });
  const agentsQueryOptions = orpc.project.agents.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const { data } = useQuery({
    ...agentsQueryOptions,
    staleTime: 10_000,
    refetchInterval: 5_000,
  });
  const presetsQueryOptions = orpc.project.agents.listPresets.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const { data: presetsData } = useQuery({
    ...presetsQueryOptions,
    staleTime: 10_000,
  });
  const createAgent = useMutation({
    mutationFn: async (input: { agentPath: string; projectSlugOrId: string }) =>
      await orpcClient.project.agents.runtimeState(input),
    onSuccess: async (_state, input) => {
      await queryClient.invalidateQueries({ queryKey: agentsQueryOptions.queryKey });
      setFilter("");
      void navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/agents/$",
        params: {
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
          _splat: agentPathToSplat(input.agentPath),
        },
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create agent.");
    },
  });
  const configurePreset = useMutation({
    mutationFn: async () => {
      const basePath = normalizeAgentPresetBasePath(presetBasePath);
      return await orpcClient.project.agents.configurePreset({
        basePath,
        events: [],
        model: presetModel.trim(),
        projectSlugOrId: project.id,
        provider: presetProvider,
        runOpts: presetProvider === "cloudflare-ai" ? parsePresetRunOpts(presetRunOpts) : {},
        systemPrompt: presetSystemPrompt.trim(),
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: presetsQueryOptions.queryKey });
      toast.success(`Configured ${result.basePath}.`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not configure preset.");
    },
  });
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

  function submitCreateAgent() {
    try {
      createAgent.mutate({
        agentPath: agentPathFromInput(filter),
        projectSlugOrId: project.id,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Agent path is invalid.");
    }
  }

  function selectPresetProvider(provider: AgentLlmProvider) {
    setPresetProvider(provider);
    setPresetModel((current) => {
      if (provider === "openai-ws" && current === "@cf/meta/llama-3.1-8b-instruct") {
        return "gpt-5.5";
      }
      if (provider === "cloudflare-ai" && current === "gpt-5.5") {
        return "@cf/meta/llama-3.1-8b-instruct";
      }
      return current;
    });
  }

  function submitConfigurePreset() {
    if (presetModel.trim() === "") {
      toast.error("Model is required.");
      return;
    }
    if (presetSystemPrompt.trim() === "") {
      toast.error("System prompt is required.");
      return;
    }
    try {
      configurePreset.mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Preset is invalid.");
    }
  }

  return (
    <section className="w-full space-y-4 p-4">
      <div className="flex justify-end">
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() =>
              void navigate({
                to: "/orgs/$organizationSlug/projects/$projectSlug/agents/new",
                params,
              })
            }
          >
            New agent
          </Button>
          <EventsDebugLink label="Open namespace in Events" namespace={project.id} streamPath="/" />
        </div>
      </div>
      <form
        className="flex w-full flex-col gap-2 md:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreateAgent();
        }}
      >
        <Input
          className="h-9 flex-1"
          placeholder="Filter or create agent path..."
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
          <Button type="submit" className="flex-1 md:flex-none" disabled={createAgent.isPending}>
            {createAgent.isPending ? "Creating..." : "Create agent"}
          </Button>
        </div>
      </form>

      <form
        className="space-y-4 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submitConfigurePreset();
        }}
      >
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_14rem]">
          <Field>
            <FieldLabel htmlFor="agent-preset-base-path">Path prefix</FieldLabel>
            <Input
              id="agent-preset-base-path"
              value={presetBasePath}
              onChange={(event) => setPresetBasePath(event.currentTarget.value)}
              placeholder="/agents"
            />
            <FieldDescription>
              Inputs such as /alice/bla/ are saved as /agents/alice/bla.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-preset-provider">Provider</FieldLabel>
            <NativeSelect
              id="agent-preset-provider"
              value={presetProvider}
              onChange={(event) =>
                selectPresetProvider(event.currentTarget.value as AgentLlmProvider)
              }
            >
              <NativeSelectOption value="openai-ws">OpenAI WebSocket</NativeSelectOption>
              <NativeSelectOption value="cloudflare-ai">Cloudflare AI Gateway</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="agent-preset-model">Model</FieldLabel>
            <Input
              id="agent-preset-model"
              value={presetModel}
              onChange={(event) => setPresetModel(event.currentTarget.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="agent-preset-system-prompt">System prompt</FieldLabel>
          <Textarea
            id="agent-preset-system-prompt"
            className="min-h-24 font-mono text-xs"
            value={presetSystemPrompt}
            onChange={(event) => setPresetSystemPrompt(event.currentTarget.value)}
          />
        </Field>
        {presetProvider === "cloudflare-ai" ? (
          <Field>
            <FieldLabel htmlFor="agent-preset-run-opts">Run options JSON</FieldLabel>
            <Textarea
              id="agent-preset-run-opts"
              className="min-h-20 font-mono text-xs"
              value={presetRunOpts}
              onChange={(event) => setPresetRunOpts(event.currentTarget.value)}
            />
          </Field>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-muted-foreground">
            {presets.length === 0
              ? "No path-prefix presets configured."
              : `${presets.length} path-prefix preset${presets.length === 1 ? "" : "s"} configured.`}
          </div>
          <Button type="submit" disabled={configurePreset.isPending}>
            {configurePreset.isPending ? "Saving..." : "Save preset"}
          </Button>
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
      </form>

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
                    <TableCell className="min-w-[28rem] py-3">
                      <Link
                        className="block min-w-0 rounded-sm text-sm font-medium hover:underline"
                        to="/orgs/$organizationSlug/projects/$projectSlug/agents/$"
                        params={{
                          organizationSlug: params.organizationSlug,
                          projectSlug: params.projectSlug,
                          _splat: agentPathToSplat(agent.agentPath),
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

function parsePresetRunOpts(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Run options must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Run options must be valid JSON.");
  }
}
