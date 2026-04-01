import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Eye, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@iterate-com/ui/components/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { z } from "zod";
import {
  CODEMODE_SOURCE_PRESETS,
  DEFAULT_CODEMODE_SOURCES,
  DEFAULT_CODEMODE_SOURCES_YAML,
  formatCodemodeSourcesYaml,
  parseCodemodeSourcesYaml,
  type CodemodeUiSource,
} from "~/lib/codemode-sources.ts";
import { CodemodeNewRunSearch, resolveCodemodeEditorCode } from "~/lib/codemode-links.ts";
import { CODEMODE_V2_STARTER } from "~/lib/codemode-v2.ts";
import { runsQueryKey } from "~/lib/runs.ts";
import { orpcClient } from "~/orpc/client.ts";

const RunFunctionForm = z.object({
  code: z.string().trim().min(1, "Code is required"),
});

export const Route = createFileRoute("/_app/runs-v2-new")({
  staticData: {
    breadcrumb: "Codemode",
  },
  validateSearch: CodemodeNewRunSearch,
  beforeLoad: ({ search }) => {
    if (!search.sources) {
      throw redirect({
        to: "/runs-v2-new",
        search: {
          code: search.code,
          sources: DEFAULT_CODEMODE_SOURCES_YAML,
        },
        replace: true,
      });
    }
  },
  component: NewRunPage,
});

function NewRunPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [isCtxSheetOpen, setIsCtxSheetOpen] = useState(false);
  const [isSourcesOpen, setIsSourcesOpen] = useState(true);
  const [sourcesYaml, setSourcesYaml] = useState(search.sources ?? DEFAULT_CODEMODE_SOURCES_YAML);
  const parsedSources = parseSourcesYamlSafely(sourcesYaml);
  const selectedSources = parsedSources.ok ? parsedSources.sources : DEFAULT_CODEMODE_SOURCES;

  useEffect(() => {
    setSourcesYaml(search.sources ?? DEFAULT_CODEMODE_SOURCES_YAML);
  }, [search.sources]);

  const syncSources = (nextSources: CodemodeUiSource[]) => {
    const nextYaml = formatCodemodeSourcesYaml(nextSources);
    setSourcesYaml(nextYaml);
    void navigate({
      search: (previous) => ({
        ...previous,
        sources: nextYaml,
      }),
      replace: true,
    });
  };

  const ctxTypeDefinitionQuery = useQuery({
    queryKey: ["codemode-ctx-type-definition", selectedSources],
    queryFn: () =>
      orpcClient.ctxTypeDefinition({
        sources: selectedSources,
      }),
    enabled: parsedSources.ok,
    placeholderData: "Loading ctx type definitions...",
  });

  const runMutation = useMutation({
    mutationFn: (input: { code: string; sources: CodemodeUiSource[] }) => orpcClient.runV2(input),
    onError: (error) => {
      toast.error(readErrorMessage(error));
    },
  });

  const form = useForm({
    defaultValues: {
      code: resolveCodemodeEditorCode(search.code),
    },
    validators: {
      onChange: RunFunctionForm,
      onSubmit: RunFunctionForm,
    },
    onSubmit: async ({ value }) => {
      if (!parsedSources.ok) {
        toast.error(parsedSources.error);
        return;
      }

      const run = await runMutation.mutateAsync({
        code: value.code.trim(),
        sources: parsedSources.sources,
      });

      await queryClient.invalidateQueries({ queryKey: runsQueryKey });
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });

  useEffect(() => {
    form.setFieldValue("code", resolveCodemodeEditorCode(search.code));
  }, [form, search.code]);

  const applySourcesYaml = (nextYaml: string) => {
    setSourcesYaml(nextYaml);

    const parsed = parseSourcesYamlSafely(nextYaml);
    if (!parsed.ok) {
      return;
    }

    void navigate({
      search: (previous) => ({
        ...previous,
        sources: nextYaml,
      }),
      replace: true,
    });
  };

  const appendPreset = (source: CodemodeUiSource) => {
    const nextSources = [...selectedSources, source];
    syncSources(nextSources);
    toast.success(`Added ${readSourceTitle(source)}`);
  };

  return (
    <section className="space-y-6 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4" />
            <span>Codemode</span>
          </div>
          <p className="max-w-4xl text-sm text-muted-foreground">
            Write the codemode function in TypeScript. Define <code>ctx</code> with YAML on the
            right. The YAML is the real source model, and the type sheet updates from the current
            valid source set.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => syncSources(DEFAULT_CODEMODE_SOURCES)}
          >
            Reset sources
          </Button>
          <Button type="button" variant="outline" render={<Link to="/examples" />}>
            Examples
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              form.setFieldValue("code", CODEMODE_V2_STARTER);
              void navigate({
                search: (previous) => ({
                  ...previous,
                  code: undefined,
                }),
                replace: true,
              });
            }}
          >
            Reset starter
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsSourcesOpen((value) => !value)}
          >
            {isSourcesOpen ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronLeft className="size-4" />
            )}
            {isSourcesOpen ? "Hide sources" : "Show sources"}
          </Button>
        </div>
      </div>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <div
          className={
            isSourcesOpen
              ? "grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(24rem,0.95fr)]"
              : "grid gap-6"
          }
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <FieldLabel htmlFor="codemode-source">Codemode snippet</FieldLabel>
                <FieldDescription>Return a value to save it with the run.</FieldDescription>
              </div>

              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button type="submit" disabled={!canSubmit || isSubmitting || !parsedSources.ok}>
                    {isSubmitting ? "Running..." : "Run codemode"}
                  </Button>
                )}
              </form.Subscribe>
            </div>

            <form.Field name="code">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <SourceCodeBlock
                      code={field.state.value}
                      language="typescript"
                      editable={true}
                      onChange={field.handleChange}
                      className="min-h-[42rem]"
                    />
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </div>

          {isSourcesOpen ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <FieldLabel htmlFor="sources-yaml">Sources YAML</FieldLabel>
                  <FieldDescription>
                    Edit the <code>sources[]</code> structure directly. Headers can include{" "}
                    <code>getIterateSecret(&#123; secretKey: &quot;...&quot; &#125;)</code>.
                  </FieldDescription>
                </div>

                <Button type="button" variant="outline" onClick={() => setIsCtxSheetOpen(true)}>
                  <Eye className="size-4" />
                  See <code>ctx</code> types
                </Button>
              </div>

              <Field data-invalid={!parsedSources.ok}>
                <SourceCodeBlock
                  code={sourcesYaml}
                  language="text"
                  editable={true}
                  onChange={applySourcesYaml}
                  className="min-h-[42rem]"
                />
                {!parsedSources.ok ? (
                  <FieldError errors={[{ message: parsedSources.error }]} />
                ) : null}
              </Field>

              <div className="flex flex-wrap gap-2">
                {CODEMODE_SOURCE_PRESETS.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => appendPreset(preset.source)}
                  >
                    {preset.title}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </form>

      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm font-medium">Need a starting point?</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse the examples page for filterable deep links into pre-populated codemode forms.
        </p>
        <div className="mt-3">
          <Button type="button" variant="outline" render={<Link to="/examples" />}>
            Browse examples
          </Button>
        </div>
      </div>

      <Sheet open={isCtxSheetOpen} onOpenChange={setIsCtxSheetOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(96vw,120rem)] data-[side=right]:sm:max-w-[min(96vw,120rem)]">
          <SheetHeader className="space-y-2 border-b pr-14">
            <SheetTitle>
              <span>Injected </span>
              <code>ctx</code>
              <span> types</span>
            </SheetTitle>
            <SheetDescription>Generated from the current valid source YAML.</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <SourceCodeBlock
              code={
                parsedSources.ok
                  ? (ctxTypeDefinitionQuery.data ?? "Loading ctx type definitions...")
                  : parsedSources.error
              }
              language="typescript"
              className="h-full min-h-0"
            />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function parseSourcesYamlSafely(yamlText: string) {
  try {
    return {
      ok: true as const,
      sources: parseCodemodeSourcesYaml(yamlText),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: readErrorMessage(error),
    };
  }
}

function readSourceTitle(source: CodemodeUiSource) {
  if (source.type === "orpc-contract") {
    return source.service;
  }

  return source.namespace?.trim() || source.url;
}
function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
