import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { z } from "zod";
import { findCodemodeExample, providersForCodemodeExample } from "~/codemode/examples.ts";
import { createBrowserOpenApiClient, orpc } from "~/orpc/client.ts";

const Search = z.object({
  example: z.string().optional(),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new",
)({
  validateSearch: Search,
  loader: async ({ context, location, params }) => {
    const search = Search.parse(location.search);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.projects.presets.list.queryOptions({ input: { projectId: project.id } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: "New Codemode Session",
      example: findCodemodeExample(search.example),
      project,
    };
  },
  component: NewCodemodeSessionPage,
});

function NewCodemodeSessionPage() {
  const params = Route.useParams();
  const { example, project } = Route.useLoaderData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: presetsData } = useQuery({
    ...orpc.projects.presets.list.queryOptions({ input: { projectId: project.id } }),
    staleTime: 30_000,
  });
  const presets = presetsData?.presets ?? [];
  const defaultCode =
    example?.code ?? 'async (ctx) => {\n  console.log("hello");\n  return 1 + 1;\n}';
  const defaultEventsJson = useMemo(
    () => JSON.stringify(example?.events ?? [], null, 2),
    [example?.events],
  );
  const [code, setCode] = useState(defaultCode);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [eventsJson, setEventsJson] = useState(defaultEventsJson);
  const [streamPath, setStreamPath] = useState("");

  const createSession = useMutation({
    mutationFn: async () => {
      const parsedCustomEvents = parseCustomEvents(eventsJson);
      const selectedPreset = presets.find((preset) => preset.id === selectedPresetId);
      const parsedStreamPath = parseOptionalStreamPath(streamPath);
      const client = createBrowserOpenApiClient();

      return await client.codemode.createSession({
        code: code.trim() === "" ? undefined : code,
        events: [...(selectedPreset?.events ?? []), ...parsedCustomEvents],
        projectId: project.id,
        providers: providersForCodemodeExample({ example, projectId: project.id }),
        ...(parsedStreamPath ? { streamPath: parsedStreamPath } : {}),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: orpc.projects.codemodeSessions.list.key() });
      void navigate({
        to: "/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/$codemodeSessionName",
        params: {
          ...params,
          codemodeSessionName: result.session.name,
        },
        search: {
          streamPath: result.session.streamPath,
        },
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const submit = useCallback(() => {
    createSession.mutate();
  }, [createSession]);

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">New Codemode Session</h2>
        <p className="text-sm text-muted-foreground">
          {example ? example.description : "Create a project-scoped codemode stream processor."}
        </p>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="codemode-code">Script</FieldLabel>
          <Textarea
            id="codemode-code"
            className="min-h-64 font-mono text-xs"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="codemode-preset">Preset</FieldLabel>
          <NativeSelect
            id="codemode-preset"
            value={selectedPresetId}
            onChange={(event) => setSelectedPresetId(event.target.value)}
            disabled={presets.length === 0}
          >
            <NativeSelectOption value="">No preset</NativeSelectOption>
            {presets.map((preset) => (
              <NativeSelectOption key={preset.id} value={preset.id}>
                {preset.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>

        <Field>
          <FieldLabel htmlFor="codemode-events">Custom events</FieldLabel>
          <Textarea
            id="codemode-events"
            className="min-h-44 font-mono text-xs"
            value={eventsJson}
            onChange={(event) => setEventsJson(event.target.value)}
            spellCheck={false}
          />
          <FieldDescription>
            JSON array of EventInput objects appended before the script.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="codemode-stream-path">Stream path</FieldLabel>
          <Input
            id="codemode-stream-path"
            value={streamPath}
            onChange={(event) => setStreamPath(event.target.value)}
            placeholder="/codemode-sessions/my-session"
          />
          <FieldDescription>Leave empty to create a new session stream.</FieldDescription>
        </Field>
      </FieldGroup>

      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={createSession.isPending}>
          {createSession.isPending ? "Creating..." : "Create session"}
        </Button>
      </div>
    </section>
  );
}

function parseCustomEvents(value: string) {
  try {
    return EventInput.array().parse(JSON.parse(value.trim() || "[]"));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Custom events must be a JSON array.");
  }
}

function parseOptionalStreamPath(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : StreamPath.parse(trimmed);
}
