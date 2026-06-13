import { Copy } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { ItxBoundary, ItxResourceError, ItxResourceLoading } from "~/components/itx-boundary.tsx";
import { useItx } from "~/itx/use-itx.ts";
import { useItxResource } from "~/itx/use-itx-resource.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/$repoSlug")({
  ssr: false,
  loader: ({ context, params }) => ({
    breadcrumb: params.repoSlug,
    project: context.project,
  }),
  component: ProjectRepoDetailPage,
});

function ProjectRepoDetailPage() {
  return (
    <ItxBoundary>
      <ProjectRepoDetailContent />
    </ItxBoundary>
  );
}

function ProjectRepoDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const itx = useItx(project.id);
  const {
    data: repo,
    status,
    error,
    refetch,
  } = useItxResource(() => itx.repos.getInfo({ slug: params.repoSlug }), [itx, params.repoSlug]);

  if (status === "error") {
    return (
      <section className="w-full p-4">
        <ItxResourceError label="repo" error={error} onRetry={() => void refetch()} />
      </section>
    );
  }

  if (!repo) {
    return (
      <section className="w-full p-4">
        <ItxResourceLoading label="repo" />
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
