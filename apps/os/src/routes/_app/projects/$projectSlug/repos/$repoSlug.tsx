import { Copy } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { projectRepoQueryOptions } from "~/lib/project-route-query.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/$repoSlug")({
  loader: async ({ context, params }) => {
    const { project } = context;
    await context.queryClient.ensureQueryData(
      projectRepoQueryOptions({ projectId: project.id, repoSlug: params.repoSlug }),
    );

    return {
      breadcrumb: params.repoSlug,
      project,
    };
  },
  component: ProjectRepoDetailPage,
});

function ProjectRepoDetailPage() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const repoQuery = useQuery(
    projectRepoQueryOptions({ projectId: project.id, repoSlug: params.repoSlug }),
  );
  const repo = repoQuery.data;

  if (!repo) {
    return (
      <section className="w-full p-4">
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">Loading Repo...</div>
      </section>
    );
  }

  return (
    <section className="w-full space-y-4 p-4">
      <div className="rounded-lg border bg-card">
        <InfoRow label="Slug" value={repo.slug} />
        <InfoRow label="Remote" value={repo.remote} copyValue={repo.remote} />
        <InfoRow label="Default branch" value={repo.defaultBranch} />
        <InfoRow label="Token expires" value={repo.tokenExpiresAt ?? "No expiry returned"} />
        <InfoRow label="Token" value={repo.token} copyValue={repo.token} />
        <InfoRow
          label="Authorization header"
          value={repo.git.authorizationHeader}
          copyValue={repo.git.authorizationHeader}
        />
      </div>

      <CommandBlock title="Clone locally" command={repo.git.cloneCommand} />
      <CommandBlock title="Commit README change" command={repo.git.commitExampleCommand} />
      <CommandBlock title="Push" command={repo.git.pushCommand} />
    </section>
  );
}

function InfoRow(input: { copyValue?: string; label: string; value: string }) {
  return (
    <div className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center">
      <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
      <code className="min-w-0 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {input.value}
      </code>
      {input.copyValue ? <CopyButton value={input.copyValue} /> : <div />}
    </div>
  );
}

function CommandBlock(input: { command: string; title: string }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{input.title}</h2>
        <CopyButton value={input.command} />
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
        {input.command}
      </pre>
    </section>
  );
}

function CopyButton(input: { value: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-8 w-8 shrink-0"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(input.value).then(
          () => toast.success("Copied"),
          () => toast.error("Could not copy"),
        );
      }}
    >
      <Copy className="h-4 w-4" />
    </Button>
  );
}
