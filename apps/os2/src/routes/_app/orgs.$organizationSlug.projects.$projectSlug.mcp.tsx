import type { PublicAppConfig } from "@iterate-com/shared/apps/config";
import { useConfig } from "@iterate-com/ui/apps/config";
import { buttonVariants } from "@iterate-com/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import type { AppConfig } from "~/app.ts";
import { buildProjectMcpUrl } from "~/lib/project-host-routing.ts";
import { orpc } from "~/orpc/client.ts";

type PublicConfig = PublicAppConfig<AppConfig>;

export const Route = createFileRoute("/_app/orgs/$organizationSlug/projects/$projectSlug/mcp")({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    return {
      breadcrumb: "MCP",
      project,
    };
  },
  component: ProjectMcpPage,
});

function ProjectMcpPage() {
  const { project } = Route.useLoaderData();
  const config = useConfig<PublicConfig>();
  const mcpUrl = buildProjectMcpUrl({
    projectSlug: project.slug,
    customHostname: project.customHostname,
    projectHostnameBases: config.projectHostnameBases,
  });

  if (!mcpUrl) {
    return (
      <section className="max-w-md space-y-3 p-4">
        <h2 className="text-sm font-semibold">MCP</h2>
        <p className="text-sm text-muted-foreground">
          This deployment does not have a project hostname base configured.
        </p>
      </section>
    );
  }

  const claudeCommand = `claude mcp add --transport http ${project.slug} ${mcpUrl}`;

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">MCP</h2>
        <p className="text-sm text-muted-foreground">
          Connect MCP clients to this project endpoint. The endpoint uses Clerk OAuth, so clients
          should authenticate through their MCP connection flow.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Endpoint</p>
        <code className="block break-all rounded-md bg-muted p-3 font-mono text-xs">{mcpUrl}</code>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Claude Code</p>
        <code className="block whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
          {claudeCommand}
        </code>
        <p className="text-sm text-muted-foreground">
          Then run <code>/mcp</code> in Claude Code and authenticate the server in the browser.
        </p>
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          href="https://docs.anthropic.com/en/docs/claude-code/mcp"
          target="_blank"
          rel="noreferrer"
        >
          Claude Code docs
        </a>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Cursor</p>
        <p className="text-sm text-muted-foreground">
          Add a remote MCP server using the endpoint above. Cursor will use the server&apos;s OAuth
          metadata to start the Clerk sign-in flow.
        </p>
        <a
          className={buttonVariants({ size: "sm", variant: "outline" })}
          href="https://docs.cursor.com/advanced/model-context-protocol"
          target="_blank"
          rel="noreferrer"
        >
          Cursor MCP docs
        </a>
      </div>
    </section>
  );
}
