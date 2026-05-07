import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Play, RotateCcw } from "lucide-react";
import { parse as parseYaml } from "yaml";
import { EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { toast } from "@iterate-com/ui/components/sonner";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { z } from "zod";
import {
  type CodemodeExampleStack,
  type CodemodeProviderInput,
  codemodeExamples,
  codemodeProviderRegistrationEvents,
  defaultCodemodeProviderRegistrationEvents,
  findCodemodeExample,
  previewCodemodeScriptExecutionEvent,
  providersForCodemodeExample,
  providersForCodemodeProviderInputs,
} from "~/domains/codemode/examples.ts";
import { createBrowserOpenApiClient, orpc } from "~/orpc/client.ts";

const Search = z.object({
  example: z.string().optional(),
});

const emptyEventsYaml = "[]\n";
const emptyHeadersYaml = "{}\n";
const defaultCode = 'async (ctx) => {\n  console.log("hello");\n  return 1 + 1;\n}';

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
  const initialScript = example?.scripts[0];
  const [selectedExampleSlug, setSelectedExampleSlug] = useState(example?.slug ?? "");
  const selectedExample = useMemo(
    () => findCodemodeExample(selectedExampleSlug),
    [selectedExampleSlug],
  );
  const [selectedScriptSlug, setSelectedScriptSlug] = useState(initialScript?.slug ?? "");
  const selectedScript =
    selectedExample?.scripts.find((script) => script.slug === selectedScriptSlug) ??
    selectedExample?.scripts[0];
  const [code, setCode] = useState(selectedScript?.code ?? defaultCode);
  const [customEventsYaml, setCustomEventsYaml] = useState(emptyEventsYaml);
  const [streamPath, setStreamPath] = useState("");
  const [mcpPath, setMcpPath] = useState("mcp.custom");
  const [mcpServerUrl, setMcpServerUrl] = useState("");
  const [mcpHeadersYaml, setMcpHeadersYaml] = useState(emptyHeadersYaml);
  const [openApiPath, setOpenApiPath] = useState("api.custom");
  const [openApiSpecUrl, setOpenApiSpecUrl] = useState("");
  const [openApiBaseUrl, setOpenApiBaseUrl] = useState("");
  const [openApiHeadersYaml, setOpenApiHeadersYaml] = useState(emptyHeadersYaml);

  const preview = useMemo(
    () =>
      buildPreviewEvents({
        code,
        customEventsYaml,
        example: selectedExample,
        mcpHeadersYaml,
        mcpPath,
        mcpServerUrl,
        openApiBaseUrl,
        openApiHeadersYaml,
        openApiPath,
        openApiSpecUrl,
        projectId: project.id,
        streamPath: parseOptionalStreamPathForPreview(streamPath) ?? "/codemode-sessions/<new>",
      }),
    [
      code,
      customEventsYaml,
      mcpHeadersYaml,
      mcpPath,
      mcpServerUrl,
      openApiBaseUrl,
      openApiHeadersYaml,
      openApiPath,
      openApiSpecUrl,
      project.id,
      selectedExample,
      streamPath,
    ],
  );

  const createSession = useMutation({
    mutationFn: async () => {
      const parsedCustomEvents = parseCustomEvents(customEventsYaml);
      const parsedStreamPath = parseOptionalStreamPath(streamPath);
      const adHocProviders = buildAdHocProviderInputs({
        mcpHeadersYaml,
        mcpPath,
        mcpServerUrl,
        openApiBaseUrl,
        openApiHeadersYaml,
        openApiPath,
        openApiSpecUrl,
      });
      const client = createBrowserOpenApiClient();

      return await client.project.codemode.createSession({
        code: code.trim() === "" ? undefined : code,
        events: [...(selectedExample?.events ?? []), ...parsedCustomEvents],
        projectSlugOrId: project.id,
        providers: [
          ...providersForCodemodeExample({ example: selectedExample, projectId: project.id }),
          ...providersForCodemodeProviderInputs({
            projectId: project.id,
            providers: adHocProviders,
          }),
        ],
        ...(parsedStreamPath ? { streamPath: parsedStreamPath } : {}),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: orpc.project.codemode.listSessions.key() });
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

  const selectExample = (slug: string) => {
    const nextExample = findCodemodeExample(slug);
    const nextScript = nextExample?.scripts[0];
    setSelectedExampleSlug(slug);
    setSelectedScriptSlug(nextScript?.slug ?? "");
    setCode(nextScript?.code ?? defaultCode);
    void navigate({
      to: "/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new",
      params,
      search: slug === "" ? {} : { example: slug },
      replace: true,
    });
  };

  const selectScript = (slug: string) => {
    const nextScript = selectedExample?.scripts.find((script) => script.slug === slug);
    setSelectedScriptSlug(slug);
    if (nextScript) setCode(nextScript.code);
  };

  const resetAdHocProviders = () => {
    setMcpPath("mcp.custom");
    setMcpServerUrl("");
    setMcpHeadersYaml(emptyHeadersYaml);
    setOpenApiPath("api.custom");
    setOpenApiSpecUrl("");
    setOpenApiBaseUrl("");
    setOpenApiHeadersYaml(emptyHeadersYaml);
  };

  return (
    <section className="w-full max-w-7xl space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">New Codemode Session</h2>
        <p className="text-sm text-muted-foreground">
          {selectedExample
            ? selectedExample.description
            : "Create a project-scoped codemode stream processor."}
        </p>
      </div>

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(440px,1.05fr)]">
        <div className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="codemode-example">Example stack</FieldLabel>
              <NativeSelect
                id="codemode-example"
                className="w-full"
                value={selectedExampleSlug}
                onChange={(event) => selectExample(event.target.value)}
              >
                <NativeSelectOption value="">Blank session</NativeSelectOption>
                {codemodeExamples.map((item) => (
                  <NativeSelectOption key={item.slug} value={item.slug}>
                    {item.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                The selected stack contributes its example events and provider registration events.
              </FieldDescription>
            </Field>

            {selectedExample && selectedExample.scripts.length > 1 ? (
              <Field>
                <FieldLabel htmlFor="codemode-script-example">Script example</FieldLabel>
                <NativeSelect
                  id="codemode-script-example"
                  className="w-full"
                  value={selectedScript?.slug ?? ""}
                  onChange={(event) => selectScript(event.target.value)}
                >
                  {selectedExample.scripts.map((script) => (
                    <NativeSelectOption key={script.slug} value={script.slug}>
                      {script.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}

            <Field>
              <FieldLabel htmlFor="codemode-code">Script</FieldLabel>
              <SourceCodeBlock
                code={code}
                className="min-h-80"
                editable
                language="typescript"
                onChange={setCode}
                onModEnter={submit}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="codemode-custom-events">Custom events</FieldLabel>
              <SourceCodeBlock
                code={customEventsYaml}
                className="min-h-44"
                editable
                language="yaml"
                onChange={setCustomEventsYaml}
              />
              <FieldDescription>
                YAML array of EventInput objects appended after the selected example events.
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

          <div className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">Ad-hoc tool providers</p>
                <p className="text-sm text-muted-foreground">
                  Filled forms compile into provider registration events in the preview.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={resetAdHocProviders}>
                <RotateCcw className="size-4" />
                Reset
              </Button>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">Outbound MCP</p>
                <Field>
                  <FieldLabel htmlFor="codemode-mcp-path">Context path</FieldLabel>
                  <Input
                    id="codemode-mcp-path"
                    value={mcpPath}
                    onChange={(event) => setMcpPath(event.target.value)}
                    placeholder="mcp.cloudflareDocs"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="codemode-mcp-url">Server URL</FieldLabel>
                  <Input
                    id="codemode-mcp-url"
                    value={mcpServerUrl}
                    onChange={(event) => setMcpServerUrl(event.target.value)}
                    placeholder="https://docs.mcp.cloudflare.com/mcp"
                  />
                </Field>
                <Field>
                  <FieldLabel>Headers</FieldLabel>
                  <SourceCodeBlock
                    code={mcpHeadersYaml}
                    className="min-h-28"
                    editable
                    language="yaml"
                    onChange={setMcpHeadersYaml}
                  />
                </Field>
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">OpenAPI</p>
                <Field>
                  <FieldLabel htmlFor="codemode-openapi-path">Context path</FieldLabel>
                  <Input
                    id="codemode-openapi-path"
                    value={openApiPath}
                    onChange={(event) => setOpenApiPath(event.target.value)}
                    placeholder="api.petstore"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="codemode-openapi-spec">Spec URL</FieldLabel>
                  <Input
                    id="codemode-openapi-spec"
                    value={openApiSpecUrl}
                    onChange={(event) => setOpenApiSpecUrl(event.target.value)}
                    placeholder="https://petstore.swagger.io/v2/swagger.json"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="codemode-openapi-base">Base URL</FieldLabel>
                  <Input
                    id="codemode-openapi-base"
                    value={openApiBaseUrl}
                    onChange={(event) => setOpenApiBaseUrl(event.target.value)}
                    placeholder="https://petstore.swagger.io/v2"
                  />
                </Field>
                <Field>
                  <FieldLabel>Headers</FieldLabel>
                  <SourceCodeBlock
                    code={openApiHeadersYaml}
                    className="min-h-28"
                    editable
                    language="yaml"
                    onChange={setOpenApiHeadersYaml}
                  />
                </Field>
              </div>
            </div>
          </div>
        </div>

        <aside className="min-h-[42rem] space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Event preview</p>
              <p className="text-sm text-muted-foreground">
                YAML preview of events createSession will append.
              </p>
            </div>
            <Button onClick={submit} disabled={createSession.isPending || preview.error != null}>
              <Play className="size-4" />
              {createSession.isPending ? "Creating..." : "Create session"}
            </Button>
          </div>

          {preview.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {preview.error}
            </div>
          ) : (
            <SerializedObjectCodeBlock
              data={preview.events}
              className="h-[42rem]"
              initialFormat="yaml"
              showToggle
            />
          )}
        </aside>
      </div>
    </section>
  );
}

function buildPreviewEvents(input: {
  code: string;
  customEventsYaml: string;
  example: CodemodeExampleStack | undefined;
  mcpHeadersYaml: string;
  mcpPath: string;
  mcpServerUrl: string;
  openApiBaseUrl: string;
  openApiHeadersYaml: string;
  openApiPath: string;
  openApiSpecUrl: string;
  projectId: string;
  streamPath: string;
}): { error?: string; events: EventInput[] } {
  try {
    const customEvents = parseCustomEvents(input.customEventsYaml);
    const adHocProviders = buildAdHocProviderInputs(input);
    const providers = [
      ...providersForCodemodeExample({ example: input.example, projectId: input.projectId }),
      ...providersForCodemodeProviderInputs({
        projectId: input.projectId,
        providers: adHocProviders,
      }),
    ];
    const scriptEvent = previewCodemodeScriptExecutionEvent({ code: input.code });
    return {
      events: [
        ...(input.example?.events ?? []),
        ...customEvents,
        ...defaultCodemodeProviderRegistrationEvents({
          projectId: input.projectId,
          streamPath: input.streamPath,
        }),
        ...codemodeProviderRegistrationEvents(providers),
        ...(scriptEvent ? [scriptEvent] : []),
      ],
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      events: [],
    };
  }
}

function buildAdHocProviderInputs(input: {
  mcpHeadersYaml: string;
  mcpPath: string;
  mcpServerUrl: string;
  openApiBaseUrl: string;
  openApiHeadersYaml: string;
  openApiPath: string;
  openApiSpecUrl: string;
}): CodemodeProviderInput[] {
  const providers: CodemodeProviderInput[] = [];
  const trimmedMcpUrl = input.mcpServerUrl.trim();
  if (trimmedMcpUrl !== "") {
    providers.push({
      type: "outbound-mcp",
      path: parseContextPath(input.mcpPath),
      serverUrl: trimmedMcpUrl,
      headers: parseHeaders(input.mcpHeadersYaml),
    });
  }

  const trimmedSpecUrl = input.openApiSpecUrl.trim();
  const trimmedBaseUrl = input.openApiBaseUrl.trim();
  if (trimmedSpecUrl !== "" || trimmedBaseUrl !== "") {
    if (trimmedSpecUrl === "" || trimmedBaseUrl === "") {
      throw new Error("OpenAPI providers require both a spec URL and a base URL.");
    }
    providers.push({
      type: "openapi",
      path: parseContextPath(input.openApiPath),
      specUrl: trimmedSpecUrl,
      baseUrl: trimmedBaseUrl,
      headers: parseHeaders(input.openApiHeadersYaml),
    });
  }

  return providers;
}

function parseCustomEvents(value: string) {
  const parsed = parseYaml(value.trim() || "[]") as unknown;
  return EventInput.array().parse(parsed);
}

function parseHeaders(value: string) {
  const parsed = parseYaml(value.trim() || "{}") as unknown;
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a YAML object.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, headerValue]) => {
      if (typeof headerValue !== "string") {
        throw new Error(`Header ${key} must be a string.`);
      }
      return [key, headerValue];
    }),
  );
}

function parseContextPath(value: string) {
  const path = value
    .trim()
    .replace(/^ctx\./, "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (path.length === 0) {
    throw new Error("Provider context path is required.");
  }

  return path;
}

function parseOptionalStreamPath(value: string) {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : StreamPath.parse(trimmed);
}

function parseOptionalStreamPathForPreview(value: string) {
  try {
    return parseOptionalStreamPath(value);
  } catch {
    return undefined;
  }
}
