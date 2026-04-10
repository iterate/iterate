import { Link, createFileRoute } from "@tanstack/react-router";
import { Copy, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  buildCodemodeNewRunHref,
  buildCodemodeNewRunSearch,
  CodemodeExamplesSearch,
} from "~/lib/codemode-links.ts";
import {
  codemodeInputLanguage,
  formatCodemodeInputForDisplay,
  resolveCodemodeEditorInput,
} from "~/lib/codemode-input.ts";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";
import { CODEMODE_EXAMPLES } from "~/lib/codemode-v2.ts";

export const Route = createFileRoute("/_app/examples")({
  staticData: {
    breadcrumb: "Examples",
  },
  validateSearch: CodemodeExamplesSearch,
  component: ExamplesPage,
});

function ExamplesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filter = search.q?.trim().toLowerCase() ?? "";
  const filteredExamples = !filter
    ? CODEMODE_EXAMPLES
    : CODEMODE_EXAMPLES.filter((example) => {
        const haystack = [
          example.title,
          example.description,
          formatExampleInputForDisplay(example),
          formatCodemodeSourcesYaml(example.sources),
        ]
          .join("\n")
          .toLowerCase();

        return haystack.includes(filter);
      });

  return (
    <section className="space-y-6 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">Examples</p>
        <p className="max-w-4xl text-sm text-muted-foreground">
          Every example opens a fully pre-populated new-run form via a deep link.
        </p>
      </div>

      <Field>
        <FieldLabel htmlFor="examples-filter">Filter examples</FieldLabel>
        <FieldDescription>
          Search across titles, descriptions, sources, and snippet text.
        </FieldDescription>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="examples-filter"
            value={search.q ?? ""}
            onChange={(event) =>
              void navigate({
                search: (previous) => ({
                  ...previous,
                  q: event.target.value || undefined,
                }),
                replace: true,
              })
            }
            placeholder="weather, holidays, stream, petstore..."
            className="pl-9"
          />
        </div>
      </Field>

      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          Showing {filteredExamples.length} of {CODEMODE_EXAMPLES.length} examples
        </p>
      </div>

      <div className="space-y-6">
        {filteredExamples.map((example) => (
          <article key={example.id} className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">{example.title}</p>
                <p className="text-sm text-muted-foreground">{example.description}</p>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {resolveExampleInput(example).type === "package-project"
                    ? "Package project"
                    : "Compiled script"}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  render={
                    <Link
                      to="/runs-v2-new"
                      search={buildCodemodeNewRunSearch({
                        input: example.input,
                        code: example.code,
                        sources: example.sources,
                      })}
                    />
                  }
                >
                  Open example
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    void copyExampleLink({
                      code: example.code,
                      input: example.input,
                      sources: example.sources,
                      title: example.title,
                    })
                  }
                >
                  <Copy className="size-4" />
                  Copy deep link
                </Button>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Sources YAML
                </p>
                <SourceCodeBlock
                  code={formatCodemodeSourcesYaml(example.sources)}
                  language="text"
                  className="min-h-52"
                />
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Codemode Input
                </p>
                <SourceCodeBlock
                  code={formatExampleInputForDisplay(example)}
                  language={codemodeInputLanguage(resolveExampleInput(example))}
                  className="min-h-52"
                />
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function resolveExampleInput(example: (typeof CODEMODE_EXAMPLES)[number]) {
  return example.input ?? resolveCodemodeEditorInput({ code: example.code });
}

function formatExampleInputForDisplay(example: (typeof CODEMODE_EXAMPLES)[number]) {
  return formatCodemodeInputForDisplay(resolveExampleInput(example));
}

async function copyExampleLink(input: {
  code: string;
  input?: (typeof CODEMODE_EXAMPLES)[number]["input"];
  sources: (typeof CODEMODE_EXAMPLES)[number]["sources"];
  title: string;
}) {
  try {
    await navigator.clipboard.writeText(
      buildCodemodeNewRunHref({
        origin: window.location.origin,
        input: input.input,
        code: input.code,
        sources: input.sources,
      }),
    );
    toast.success(`Copied deep link for "${input.title}"`);
  } catch {
    toast.error(`Failed to copy deep link for "${input.title}"`);
  }
}
