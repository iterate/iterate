import { useLiveState } from "iterate/sdk/itx/react";
import type { RepoProcessorState } from "../../domains/repos/repo-processor-contract.ts";

/**
 * Template provenance for the repo IDE sidebar — display only, reading the
 * durable `createRequest` the repo processor already reduces. An `empty`
 * create IS the Default template; GitHub imports have no template and render
 * nothing. There is deliberately no sync button here: re-syncing against a
 * template is an admin script (apps/os/docs/worker-health-runbook.md), not a
 * product surface.
 */
export function RepoTemplatePanel({ repoPath }: { repoPath: string }) {
  const state = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (s) => ({ createRequest: s.createRequest }),
    [repoPath],
  ).value;

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
