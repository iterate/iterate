import { useMutation } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";
import { useItx, useLiveState } from "iterate/sdk/itx/react";
import type { RepoProcessorState } from "../../domains/repos/repo-processor-contract.ts";

/**
 * Template provenance row for the repo IDE sidebar: where the repo's files
 * came from ("Created from …") plus the one-click "Update to latest template"
 * button (`repo.syncFromTemplate`). Rendered only for template-created repos
 * — `empty` creates ARE the Default template, so they show it too; GitHub
 * imports have no template and render nothing.
 */
export function RepoTemplatePanel({ repoPath }: { repoPath: string }) {
  const itx = useItx();
  const state = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (s) => ({
      createRequest: s.createRequest,
      lastTemplateSync: s.lastTemplateSync,
    }),
    [repoPath],
  ).value;

  const sync = useMutation({
    mutationFn: () => itx.repos.get(repoPath).syncFromTemplate(),
    onSuccess: (result) => {
      if (result.upToDate) {
        toast.success("Already up to date with the template.");
        return;
      }
      const updated =
        result.updated.length === 0
          ? null
          : `Updated ${result.updated.length} file(s): ${result.updated.join(", ")}.`;
      const skipped =
        result.skipped.length === 0
          ? null
          : `Skipped ${result.skipped.length} file(s) you edited: ${result.skipped.join(", ")} — the template changed these too, so your versions stand.`;
      if (updated) {
        toast.success(`Synced from template @ ${result.templateCommitOid.slice(0, 7)}.`, {
          description: [updated, skipped].filter(Boolean).join(" "),
        });
      } else {
        toast.info("Nothing to update from the template.", {
          description: skipped || undefined,
        });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Template sync failed."),
  });

  const source = templateSourceLabel(state === undefined ? null : state.createRequest);
  if (source === null) return null;

  return (
    <div className="flex flex-col gap-1.5 border-b p-3">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Template
      </span>
      <span className="text-xs text-muted-foreground">
        Created from <span className="font-mono">{source}</span>
      </span>
      {state?.lastTemplateSync ? (
        <span className="text-xs text-muted-foreground">
          Last synced @{" "}
          <span className="font-mono">{state.lastTemplateSync.templateCommitOid.slice(0, 7)}</span>
        </span>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="text-xs"
        disabled={sync.isPending}
        // The sync fetches the template from GitHub and commits — visible
        // progress, and the marker the spec waiters key on.
        data-spinner={sync.isPending ? "true" : undefined}
        onClick={() => sync.mutate()}
      >
        {sync.isPending ? "Updating…" : "Update to latest template"}
      </Button>
    </div>
  );
}

/** Human-readable provenance, or null when the repo has no template (imports). */
function templateSourceLabel(createRequest: RepoProcessorState["createRequest"]): string | null {
  if (createRequest === null) return null;
  if (createRequest.type === "empty") return "iterate/iterate/configs/default (Default)";
  if (createRequest.type !== "github-public-template") return null;
  const location = [createRequest.owner, createRequest.repo, createRequest.path]
    .filter(Boolean)
    .join("/");
  return createRequest.ref === undefined ? location : `${location} @ ${createRequest.ref}`;
}
