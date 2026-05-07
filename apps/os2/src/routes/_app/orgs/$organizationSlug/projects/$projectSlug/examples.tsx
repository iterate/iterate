import { Link, createFileRoute } from "@tanstack/react-router";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { codemodeExamples } from "~/codemode/examples.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/examples")(
  {
    loader: async ({ context, params }) => {
      await context.queryClient.ensureQueryData({
        ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
        staleTime: 30_000,
      });

      return {
        breadcrumb: "Examples",
      };
    },
    component: ExamplesPage,
  },
);

function ExamplesPage() {
  const params = Route.useParams();

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Examples</h2>
        <p className="text-sm text-muted-foreground">
          Static codemode templates that create project-specific sessions.
        </p>
      </div>

      <div className="space-y-3">
        {codemodeExamples.map((example) => (
          <div
            key={example.slug}
            className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className="space-y-1">
                <p className="font-medium">{example.name}</p>
                <p className="text-sm text-muted-foreground">{example.description}</p>
              </div>
              <pre className="line-clamp-4 overflow-hidden rounded-md bg-muted p-3 font-mono text-xs">
                {example.code}
              </pre>
            </div>
            <Link
              className={buttonVariants({ size: "sm", variant: "outline" })}
              to="/orgs/$organizationSlug/projects/$projectSlug/codemode-sessions/new"
              params={params}
              search={{ example: example.slug }}
            >
              Run
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
