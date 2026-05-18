import { Link, createFileRoute } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import {
  codemodeExamples,
  codemodeProviderRegistrationEvents,
  defaultCodemodeProviderRegistrationEvents,
  providersForCodemodeExample,
} from "~/domains/codemode/examples.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/examples")(
  {
    loader: async ({ context, params }) => {
      const project = await context.queryClient.ensureQueryData({
        ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
        staleTime: 30_000,
      });

      return {
        breadcrumb: "Examples",
        project,
      };
    },
    component: ExamplesPage,
  },
);

function ExamplesPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();

  return (
    <section className="w-full max-w-7xl space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Examples</h2>
        <p className="text-sm text-muted-foreground">
          Codemode stacks combine authored events, tool provider registrations, and runnable
          scripts.
        </p>
      </div>

      <div className="space-y-4">
        {codemodeExamples.map((example) => {
          const providerEvents = [
            ...defaultCodemodeProviderRegistrationEvents({
              projectId: project.id,
              streamPath: "/codemode-sessions/<new>",
            }),
            ...codemodeProviderRegistrationEvents(
              providersForCodemodeExample({ example, projectId: project.id }),
            ),
          ];

          return (
            <div key={example.slug} className="space-y-4 rounded-lg border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{example.name}</p>
                  <p className="text-sm text-muted-foreground">{example.description}</p>
                </div>
                <Link
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  to="/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new"
                  params={params}
                  search={{ example: example.slug }}
                >
                  <Play className="size-4" />
                  Run
                </Link>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                <div className="min-w-0 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Authored events</p>
                  <SerializedObjectCodeBlock
                    data={example.events}
                    className="h-72"
                    initialFormat="yaml"
                    showToggle
                  />
                </div>

                <div className="min-w-0 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Provider registration events
                  </p>
                  <SerializedObjectCodeBlock
                    data={providerEvents}
                    className="h-72"
                    initialFormat="yaml"
                    showToggle
                  />
                </div>

                <div className="min-w-0 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Script</p>
                  <SourceCodeBlock
                    code={example.scripts[0]?.code ?? ""}
                    className="h-72"
                    language="typescript"
                    showCopyButton
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
