import { useNavigate } from "@tanstack/react-router";
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
  CodemodeExamplesSearchSchema,
} from "~/lib/codemode-links.ts";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";
import { CODEMODE_EXAMPLES } from "~/lib/codemode-v2.ts";

export const Route = createFileRoute("/_app/examples")({
  staticData: {
    breadcrumb: "Examples",
  },
  validateSearch: CodemodeExamplesSearchSchema,
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
          example.code,
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
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  render={
                    <Link
                      to="/runs-v2-new"
                      search={buildCodemodeNewRunSearch({
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
                  onClick={() => void copyExampleLink(example.code, example.sources, example.title)}
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
                  Code
                </p>
                <SourceCodeBlock code={example.code} language="typescript" className="min-h-52" />
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

async function copyExampleLink(
  code: string,
  sources: (typeof CODEMODE_EXAMPLES)[number]["sources"],
  title: string,
) {
  try {
    await navigator.clipboard.writeText(
      buildCodemodeNewRunHref({
        origin: window.location.origin,
        code,
        sources,
      }),
    );
    toast.success(`Copied deep link for "${title}"`);
  } catch {
    toast.error(`Failed to copy deep link for "${title}"`);
  }
}
