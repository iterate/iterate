import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Eye, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { z } from "zod";
import type { CodemodeInput } from "@iterate-com/codemode-contract";
import {
  CODEMODE_PACKAGE_PROJECT_STARTER,
  DEFAULT_CODEMODE_INPUT,
  formatCodemodeProjectFilesYaml,
  parseCodemodeProjectFilesYaml,
} from "~/lib/codemode-input.ts";
import { CodemodeNewRunSearch, resolveCodemodeSearchInput } from "~/lib/codemode-links.ts";
import {
  CODEMODE_SOURCE_PRESETS,
  DEFAULT_CODEMODE_SOURCES,
  DEFAULT_CODEMODE_SOURCES_YAML,
  formatCodemodeSourcesYaml,
  parseCodemodeSourcesYaml,
  type CodemodeUiSource,
} from "~/lib/codemode-sources.ts";
import { orpc, orpcClient } from "~/orpc/client.ts";

const RunFunctionForm = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("compiled-script"),
    compiledScript: z.string().trim().min(1, "Script is required"),
    packageEntryPoint: z.string(),
    packageFilesYaml: z.string(),
  }),
  z.object({
    mode: z.literal("package-project"),
    compiledScript: z.string(),
    packageEntryPoint: z.string().trim().min(1, "Entry point is required"),
    packageFilesYaml: z.string().trim().min(1, "Files YAML is required"),
  }),
]);

export const Route = createFileRoute("/_app/runs-v2-new")({
  staticData: {
    breadcrumb: "Codemode",
  },
  validateSearch: CodemodeNewRunSearch,
  component: NewRunPage,
});

function NewRunPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [isCtxSheetOpen, setIsCtxSheetOpen] = useState(false);
  const [isSourcesOpen, setIsSourcesOpen] = useState(true);
  const [sourcesYaml, setSourcesYaml] = useState(
    () => search.sources ?? DEFAULT_CODEMODE_SOURCES_YAML,
  );
  const initialInput = resolveCodemodeSearchInput(search);
  const parsedSources = parseSourcesYamlSafely(sourcesYaml);
  const selectedSources = parsedSources.ok ? parsedSources.sources : DEFAULT_CODEMODE_SOURCES;

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
    mutationFn: (input: { input: CodemodeInput; sources: CodemodeUiSource[] }) =>
      orpcClient.runV2(input),
    onError: (error) => {
      toast.error(readErrorMessage(error));
    },
  });

  const form = useForm({
    defaultValues: createFormDefaults(initialInput),
    validators: {
      onChange: RunFunctionForm,
      onSubmit: RunFunctionForm,
    },
    onSubmit: async ({ value }) => {
      if (!parsedSources.ok) {
        toast.error(parsedSources.error);
        return;
      }

      const input = buildCodemodeInputFromForm(value);
      if (!input.ok) {
        toast.error(input.error);
        return;
      }

      const run = await runMutation.mutateAsync({
        input: input.value,
        sources: parsedSources.sources,
      });

      await queryClient.invalidateQueries({
        queryKey: orpc.runs.list.key(),
      });
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });

  const applySourcesYaml = (nextYaml: string) => {
    setSourcesYaml(nextYaml);
  };

  const appendPreset = (source: CodemodeUiSource) => {
    const nextSources = [...selectedSources, source];
    setSourcesYaml(formatCodemodeSourcesYaml(nextSources));
    toast.success(`Added ${readSourceTitle(source)}`);
  };

  const resetStarter = () => {
    const mode = form.getFieldValue("mode");

    if (mode === "package-project") {
      form.setFieldValue("packageEntryPoint", CODEMODE_PACKAGE_PROJECT_STARTER.entryPoint);
      form.setFieldValue(
        "packageFilesYaml",
        formatCodemodeProjectFilesYaml(CODEMODE_PACKAGE_PROJECT_STARTER.files),
      );
      return;
    }

    form.setFieldValue("compiledScript", DEFAULT_CODEMODE_INPUT.script);
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
            Switch between a single compiled script and a package-backed file tree. Both run with
            the same injected <code>ctx</code>, and package mode can bundle npm imports like{" "}
            <code>openai</code>.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setSourcesYaml(DEFAULT_CODEMODE_SOURCES_YAML)}
          >
            Reset sources
          </Button>
          <Button type="button" variant="outline" render={<Link to="/examples" />}>
            Examples
          </Button>
          <Button type="button" variant="outline" onClick={resetStarter}>
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
              <div className="space-y-2">
                <div>
                  <FieldLabel>Runtime input</FieldLabel>
                  <FieldDescription>
                    Choose whether codemode should run a single module or bundle a package project.
                  </FieldDescription>
                </div>

                <form.Subscribe selector={(state) => state.values.mode}>
                  {(mode) => (
                    <div className="inline-flex rounded-lg border bg-muted/40 p-1">
                      <Button
                        type="button"
                        size="sm"
                        variant={mode === "compiled-script" ? "secondary" : "ghost"}
                        onClick={() => form.setFieldValue("mode", "compiled-script")}
                      >
                        Compiled script
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={mode === "package-project" ? "secondary" : "ghost"}
                        onClick={() => form.setFieldValue("mode", "package-project")}
                      >
                        Package project
                      </Button>
                    </div>
                  )}
                </form.Subscribe>
              </div>

              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button type="submit" disabled={!canSubmit || isSubmitting || !parsedSources.ok}>
                    {isSubmitting ? "Running..." : "Run codemode"}
                  </Button>
                )}
              </form.Subscribe>
            </div>

            <form.Subscribe selector={(state) => state.values.mode}>
              {(mode) =>
                mode === "package-project" ? (
                  <div className="space-y-3">
                    <Field>
                      <FieldLabel htmlFor="package-entry-point">Entry point</FieldLabel>
                      <FieldDescription>
                        This file is imported as the project entry. Export a default async function
                        or a named <code>run</code>.
                      </FieldDescription>
                      <form.Field name="packageEntryPoint">
                        {(field) => (
                          <Input
                            id="package-entry-point"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                        )}
                      </form.Field>
                    </Field>

                    <form.Field name="packageFilesYaml">
                      {(field) => {
                        const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor="package-files">Project files YAML</FieldLabel>
                            <FieldDescription>
                              Include <code>package.json</code> plus source files. Use{" "}
                              <code>
                                getIterateSecret(&#123; secretKey: &quot;...&quot; &#125;)
                              </code>{" "}
                              inside your entry function for API keys.
                            </FieldDescription>
                            <SourceCodeBlock
                              code={field.state.value}
                              language="text"
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
                ) : (
                  <form.Field name="compiledScript">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor="codemode-source">Compiled script</FieldLabel>
                          <FieldDescription>
                            Paste a bundled module or a bare async function. Export default or a
                            named <code>run</code> for full module mode.
                          </FieldDescription>
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
                )
              }
            </form.Subscribe>
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

function createFormDefaults(input: CodemodeInput) {
  if (input.type === "package-project") {
    return {
      mode: input.type,
      compiledScript: DEFAULT_CODEMODE_INPUT.script,
      packageEntryPoint: input.entryPoint,
      packageFilesYaml: formatCodemodeProjectFilesYaml(input.files),
    } as const;
  }

  return {
    mode: input.type,
    compiledScript: input.script,
    packageEntryPoint: CODEMODE_PACKAGE_PROJECT_STARTER.entryPoint,
    packageFilesYaml: formatCodemodeProjectFilesYaml(CODEMODE_PACKAGE_PROJECT_STARTER.files),
  } as const;
}

function buildCodemodeInputFromForm(value: z.infer<typeof RunFunctionForm>) {
  if (value.mode === "package-project") {
    const parsedFiles = parseCodemodeProjectFilesYaml(value.packageFilesYaml);

    if (!parsedFiles.ok) {
      return {
        ok: false as const,
        error: parsedFiles.error,
      };
    }

    return {
      ok: true as const,
      value: {
        type: "package-project" as const,
        entryPoint: value.packageEntryPoint.trim(),
        files: parsedFiles.files,
      },
    };
  }

  return {
    ok: true as const,
    value: {
      type: "compiled-script" as const,
      script: value.compiledScript.trim(),
    },
  };
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

  if (source.type === "openapi-inline") {
    return source.namespace?.trim() || source.baseUrl || "inline-openapi";
  }

  return source.namespace?.trim() || source.url;
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
