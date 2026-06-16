import { buttonVariants } from "@iterate-com/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { buildProjectMcpUrl } from "~/lib/project-host-routing.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/mcp")({
  ssr: false,
  loader: async ({ context }) => ({
    breadcrumb: "/mcp",
    project: context.project,
    routeConfig: await getPublicRouteConfig(),
  }),
  component: ProjectMcpPage,
});

function ProjectMcpPage() {
  const { project, routeConfig } = Route.useLoaderData();
  const mcpUrl = buildProjectMcpUrl({
    baseUrl: routeConfig.baseUrl,
    mcpBaseUrl: routeConfig.mcpBaseUrl,
    projectSlug: project.slug,
    projectHostnameBases: routeConfig.projectHostnameBases,
  });

  if (!mcpUrl) {
    return (
      <section className="max-w-md space-y-3 p-4">
        <h2 className="text-sm font-semibold">MCP</h2>
        <p className="text-sm text-muted-foreground">
          This deployment does not have an MCP base URL configured.
        </p>
      </section>
    );
  }

  const claudeCommand = `claude mcp add --transport http ${project.slug} ${mcpUrl}`;
  const cliBaseHostFlag =
    routeConfig.mcpBaseUrl && routeConfig.mcpBaseUrl !== "https://mcp.iterate.com"
      ? ` --base-host ${routeConfig.mcpBaseUrl}`
      : "";
  const cliCommand = `cd apps/os && pnpm cli claude-mcp${cliBaseHostFlag}`;
  const cliCommandHint =
    routeConfig.baseUrl === "https://os.iterate.com"
      ? "Run from the repo root. Uses the admin token for auth and disables all other MCP servers. For production, prefix with: doppler run --project os --config prd --"
      : "Run from the repo root. Uses the admin token for auth and disables all other MCP servers.";

  return (
    <section className="max-w-md space-y-4 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">MCP</h2>
        <p className="text-sm text-muted-foreground">
          Connect MCP clients to Iterate OS. The auth flow lets you choose which projects this
          client can access.
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
        <p className="text-xs uppercase tracking-wide text-muted-foreground">CLI Script</p>
        <code className="block whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
          {cliCommand}
        </code>
        <p className="text-sm text-muted-foreground">{cliCommandHint}</p>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Cursor</p>
        <p className="text-sm text-muted-foreground">
          Add a remote MCP server using the endpoint above. Cursor will use the server&apos;s OAuth
          metadata to start the Iterate Auth sign-in flow.
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
