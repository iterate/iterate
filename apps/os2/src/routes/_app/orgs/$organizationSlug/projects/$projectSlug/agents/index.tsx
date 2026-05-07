import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buttonVariants } from "@iterate-com/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@iterate-com/ui/components/combobox";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { orpc } from "~/orpc/client.ts";
import { streamPathFromInput, streamPathToSplat } from "~/lib/stream-links.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/agents/")({
  ssr: false,
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.agents.list.queryOptions({ input: { projectSlugOrId: project.id } }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: "Agents",
      project,
    };
  },
  component: ProjectAgentsPage,
});

function ProjectAgentsPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [agentPathInput, setAgentPathInput] = useState("/agents/default");
  const agentPath = useMemo(() => {
    try {
      return streamPathFromInput(agentPathInput);
    } catch {
      return null;
    }
  }, [agentPathInput]);
  const agentsQueryOptions = orpc.project.agents.list.queryOptions({
    input: { projectSlugOrId: project.id },
  });
  const { data: agentsData } = useQuery({
    ...agentsQueryOptions,
    staleTime: 10_000,
    refetchInterval: 5_000,
  });
  const sendMessage = useMutation(
    orpc.project.agents.sendMessage.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: agentsQueryOptions.queryKey });
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Could not send message.");
      },
    }),
  );
  const agentPaths = useMemo(
    () => (agentsData?.agents ?? []).map((agent) => agent.agentPath),
    [agentsData?.agents],
  );

  async function submitAgentMessage(message: string) {
    const streamPath = agentPath;
    if (streamPath == null) {
      throw new Error("Agent path must be a valid stream path.");
    }

    await sendMessage.mutateAsync({
      agentPath: streamPath,
      message,
      projectSlugOrId: project.id,
    });
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b p-4">
        <form
          className="flex w-full flex-col gap-2 md:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <Combobox<string>
            items={agentPaths}
            inputValue={agentPathInput}
            onInputValueChange={(value) => setAgentPathInput(value)}
            onValueChange={(value) => {
              if (value) setAgentPathInput(value);
            }}
          >
            <ComboboxInput
              className="h-9 flex-1"
              placeholder="/agents/default"
              showClear={false}
              showTrigger={agentPaths.length > 0}
            />
            <ComboboxContent>
              <ComboboxEmpty>No agents match.</ComboboxEmpty>
              <ComboboxList>
                {agentPaths.map((path) => (
                  <ComboboxItem key={path} value={path}>
                    <EventsStreamPathLabel path={path} className="min-w-0" />
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          {agentPath == null ? null : (
            <Link
              className={cn(buttonVariants({ variant: "outline" }), "md:shrink-0")}
              to="/orgs/$organizationSlug/projects/$projectSlug/streams/$"
              params={{
                organizationSlug: params.organizationSlug,
                projectSlug: params.projectSlug,
                _splat: streamPathToSplat(agentPath),
              }}
            >
              Open stream
            </Link>
          )}
        </form>
      </div>

      {agentPath == null ? (
        <div className="p-4 text-sm text-muted-foreground">
          Agent path must be a valid stream path.
        </div>
      ) : (
        <ProjectStreamView
          emptyLabel="No events on this agent stream yet."
          messageComposer={{
            onSubmit: submitAgentMessage,
            placeholder: "Message this agent",
          }}
          organizationSlug={params.organizationSlug}
          projectSlug={params.projectSlug}
          projectSlugOrId={project.id}
          streamPath={agentPath}
        />
      )}
    </section>
  );
}
