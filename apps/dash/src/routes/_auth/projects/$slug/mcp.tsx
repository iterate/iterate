// /projects/<slug>/mcp — connect a coding agent to this project over MCP: the server, the one-line
// installs for Claude Code and the Codex CLI, the sign-in that follows (the platform's OAuth, this
// project ticked at consent), and how the `run` tool picks the project. Every command is copyable.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Identifier } from "@iterate-com/ui/components/identifier";

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/mcp")({
  component: ProjectMcp,
});

/** A command or value to copy, on its own line — the shared identifier pill, allowed to wrap. */
function Copyable({ value }: { value: string }) {
  return (
    <Identifier
      value={value}
      className="max-w-full rounded-md bg-muted px-2 py-1"
      textClassName="whitespace-normal break-all"
    />
  );
}

function ProjectMcp() {
  const { project } = projectRoute.useRouteContext();
  const { info } = shell.useRouteContext();
  // the MCP server: its own origin when the deployment has one, else `/mcp` on the platform's
  const server = info.mcpOrigin ? `${info.mcpOrigin}/` : `${info.platformOrigin}/mcp`;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">MCP</h1>
        <p className="text-sm text-muted-foreground">
          One tool, <code>run</code>: a script evaluated in your connection's own context of this
          project, under your grant — every script you run is on that context's log.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
          <CardDescription>
            The platform's MCP server. It authenticates with the same sign-in as the dash.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Copyable value={server} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Claude Code</CardTitle>
          <CardDescription>
            Add the server, then sign in from inside Claude Code: run <code>/mcp</code>, pick{" "}
            <code>iterate</code>, Authenticate. At consent, tick <code>{project.slug}</code> (or
            every project).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Copyable value={`claude mcp add --transport http iterate ${server}`} />
          <Copyable value="/mcp" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Codex CLI</CardTitle>
          <CardDescription>
            Add the server, then sign in — the same consent, this project ticked.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Copyable value={`codex mcp add iterate --url ${server}`} />
          <Copyable value="codex mcp login iterate" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Which project</CardTitle>
          <CardDescription>
            With one project in the grant, <code>run</code> needs no <code>project</code>. Otherwise
            name this one — by slug or by id.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Identifier value={project.slug} />
          <Identifier value={project.id} />
        </CardContent>
      </Card>
    </div>
  );
}
