import { Suspense, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import type { RepoProcessorState } from "../../domains/repos/repo-processor-contract.ts";
import {
  GITHUB_HISTORY_RESOLUTION_OPTIONS,
  githubHistoryMergeAgentInstructions,
  githubHistoryMergeAgentPath,
  isGithubHistoryConflictError,
  type GithubHistoryResolutionChoice,
} from "./github-history-resolution.ts";
import type { InstallationRepo } from "~/components/github-installation-repos.ts";
import { InstallationRepoPicker } from "~/components/github-installation-repos.tsx";
import { useItx, useItxQuery, useLiveState } from "~/itx/itx-react.tsx";

type HistoryResolution = {
  owner: string;
  repo: string;
  reason: string;
  preferred: GithubHistoryResolutionChoice;
};

/**
 * The GitHub sidebar of the repo IDE: shows the repo's GitHub link (owner/
 * repo, connection, last mirror-push outcome) with push/sync/unlink actions,
 * or — when unlinked — a link form over the project's GitHub connections.
 * Connecting prefers pulling from GitHub; when histories diverge, a small
 * resolution step offers force-pull, force-push, or an agent merge.
 *
 * Resolution state lives on this parent so a successful `linkGithub` (which
 * flips `state.github` live) does not unmount the conflict step mid-flow.
 */
export function RepoGithubPanel({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const itx = useItx();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectSlug?: string };
  const [resolution, setResolution] = useState<HistoryResolution | null>(null);
  const repoProcessor = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (state) => state,
    [repoPath],
  );
  const state = repoProcessor.value;

  const resolve = useMutation({
    mutationFn: async (choice: GithubHistoryResolutionChoice) => {
      if (resolution === null) throw new Error("Nothing to resolve.");
      const handle = itx.repos.get(repoPath);
      if (choice === "pull") {
        return {
          kind: "pull" as const,
          result: await handle.syncFromGithub({ force: true }),
        };
      }
      if (choice === "push") {
        return {
          kind: "push" as const,
          result: await handle.pushToGithub({ force: true }),
        };
      }
      const agentPath = githubHistoryMergeAgentPath(repoPath);
      await itx.agents.get(agentPath).message(
        githubHistoryMergeAgentInstructions({
          owner: resolution.owner,
          repo: resolution.repo,
          repoPath,
        }),
      );
      return { kind: "agent" as const, agentPath };
    },
    onSuccess: (outcome) => {
      setResolution(null);
      if (outcome.kind === "pull") {
        toast.success(
          outcome.result.changed
            ? `Replaced project history with GitHub's ${outcome.result.commitOid.slice(0, 7)}.`
            : "Already at GitHub's head.",
        );
        return;
      }
      if (outcome.kind === "push") {
        toast.success(`Force-pushed ${outcome.result.commitOid.slice(0, 7)} to GitHub.`);
        return;
      }
      toast.success("Started a merge agent.");
      if (params.projectSlug !== undefined) {
        void navigate({
          to: "/projects/$projectSlug/agents/streams/$",
          params: { projectSlug: params.projectSlug, _splat: outcome.agentPath },
          search: {},
        });
      }
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not resolve histories."),
  });

  if (state === undefined) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
        Loading…
      </div>
    );
  }

  if (resolution !== null) {
    return (
      <HistoryResolutionStep
        reason={resolution.reason}
        defaultChoice={resolution.preferred}
        busy={resolve.isPending}
        onCancel={() => setResolution(null)}
        onConfirm={(choice) => resolve.mutate(choice)}
      />
    );
  }

  return state.github === null ? (
    <LinkForm
      projectId={projectId}
      repoPath={repoPath}
      onHistoryConflict={(next) => setResolution(next)}
    />
  ) : (
    <LinkedPanel
      repoPath={repoPath}
      github={state.github}
      lastPush={state.lastGithubPush}
      onHistoryConflict={(next) => setResolution(next)}
    />
  );
}

function LinkedPanel({
  repoPath,
  github,
  lastPush,
  onHistoryConflict,
}: {
  repoPath: string;
  github: NonNullable<RepoProcessorState["github"]>;
  lastPush: RepoProcessorState["lastGithubPush"];
  onHistoryConflict: (resolution: HistoryResolution) => void;
}) {
  const itx = useItx();
  const push = useMutation({
    mutationFn: () => itx.repos.get(repoPath).pushToGithub({}),
    onSuccess: (result) => toast.success(`Pushed ${result.commitOid.slice(0, 7)} to GitHub.`),
    onError: (error) => {
      if (isGithubHistoryConflictError(error)) {
        onHistoryConflict({
          owner: github.owner,
          repo: github.repo,
          preferred: "push",
          reason:
            error instanceof Error
              ? error.message
              : "GitHub rejected the push (histories have diverged).",
        });
        return;
      }
      toast.error(error instanceof Error ? error.message : "Push failed.");
    },
  });
  const sync = useMutation({
    mutationFn: () => itx.repos.get(repoPath).syncFromGithub({}),
    onSuccess: (result) =>
      toast.success(
        result.changed
          ? `Synced to GitHub's head ${result.commitOid.slice(0, 7)}.`
          : "Already at GitHub's head.",
      ),
    onError: (error) => {
      if (isGithubHistoryConflictError(error)) {
        onHistoryConflict({
          owner: github.owner,
          repo: github.repo,
          preferred: "pull",
          reason:
            error instanceof Error
              ? error.message
              : "Cannot fast-forward from GitHub (histories have diverged).",
        });
        return;
      }
      toast.error(error instanceof Error ? error.message : "Sync failed.");
    },
  });
  const unlink = useMutation({
    mutationFn: () => itx.repos.get(repoPath).unlinkGithub(),
    onSuccess: () => toast.success("GitHub link removed."),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not unlink."),
  });
  const busy = push.isPending || sync.isPending || unlink.isPending;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Linked repository
        </span>
        <a
          className="flex items-center gap-1 font-mono text-xs underline underline-offset-2"
          href={`https://github.com/${github.owner}/${github.repo}`}
          rel="noreferrer"
          target="_blank"
        >
          {github.owner}/{github.repo}
          <ExternalLinkIcon className="size-3" />
        </a>
        <span className="text-xs text-muted-foreground">via {github.connection}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Last mirror push
        </span>
        {lastPush === null ? (
          <span className="text-xs text-muted-foreground">None yet.</span>
        ) : lastPush.ok ? (
          <span className="text-xs text-muted-foreground">
            ok — <span className="font-mono">{lastPush.commitOid?.slice(0, 7)}</span> at{" "}
            {lastPush.at}
          </span>
        ) : (
          <span className="break-all text-xs text-red-600">
            failed at {lastPush.at}: {lastPush.error}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={busy}
          onClick={() => push.mutate()}
        >
          {push.isPending ? "Pushing…" : "Push now"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-xs"
          disabled={busy}
          onClick={() => sync.mutate()}
        >
          {sync.isPending ? "Syncing…" : "Sync from GitHub"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="text-xs"
          disabled={busy}
          onClick={() => unlink.mutate()}
        >
          {unlink.isPending ? "Unlinking…" : "Unlink"}
        </Button>
      </div>
    </div>
  );
}

function LinkForm({
  projectId,
  repoPath,
  onHistoryConflict,
}: {
  projectId: string;
  repoPath: string;
  onHistoryConflict: (resolution: HistoryResolution) => void;
}) {
  const itx = useItx();
  const params = useParams({ strict: false }) as { projectSlug?: string };
  const connections = useItxQuery({
    key: ["github-connections", projectId],
    query: async (itx) => {
      const entries = await itx.integrations.list();
      // Only builtin GitHub connections can back a repo (they carry the App
      // installation the mirror pushes authenticate through).
      return entries.flatMap((entry) =>
        entry.source === "builtin" && entry.integration === "github" ? [entry.connection] : [],
      );
    },
  });
  // Default to the first connection so the Octokit installation list loads
  // immediately — same ergonomics as "Add from GitHub" on the repos page.
  const [connection, setConnection] = useState(connections[0] ?? "");
  const [selected, setSelected] = useState<InstallationRepo | null>(null);

  const link = useMutation({
    mutationFn: async () => {
      if (selected === null) throw new Error("Pick a GitHub repository.");
      const handle = itx.repos.get(repoPath);
      const result = await handle.linkGithub({
        connection,
        owner: selected.owner,
        repo: selected.name,
      });
      // Prefer GitHub's history when connecting: try a non-forced pull first.
      // Empty / already-aligned GitHub is a no-op success; unrelated history
      // surfaces as a conflict for the resolution step.
      try {
        const sync = await handle.syncFromGithub({});
        return {
          kind: "synced" as const,
          result,
          sync,
        };
      } catch (syncError) {
        if (isGithubHistoryConflictError(syncError)) {
          return {
            kind: "conflict" as const,
            result,
            reason:
              syncError instanceof Error
                ? syncError.message
                : "Histories diverged; choose how to reconcile.",
          };
        }
        // Sync failed for a non-conflict reason (empty GitHub branch, network,
        // …). If the seed push already landed, the link is usable; otherwise
        // surface the better error.
        if (result.initialPush.ok) {
          return { kind: "pushed" as const, result };
        }
        throw syncError instanceof Error
          ? syncError
          : new Error(
              result.initialPush.error ??
                (syncError instanceof Error ? syncError.message : String(syncError)),
            );
      }
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "conflict") {
        onHistoryConflict({
          owner: outcome.result.owner,
          repo: outcome.result.repo,
          preferred: "pull",
          reason: outcome.reason,
        });
        return;
      }
      if (outcome.kind === "synced") {
        toast.success(
          outcome.sync.changed
            ? `Linked to ${outcome.result.owner}/${outcome.result.repo} and pulled GitHub's ${outcome.sync.commitOid.slice(0, 7)}.`
            : `Linked to ${outcome.result.owner}/${outcome.result.repo}${outcome.result.created ? " (created)" : ""}; already aligned with GitHub.`,
        );
        return;
      }
      toast.success(
        `Linked to ${outcome.result.owner}/${outcome.result.repo}${outcome.result.created ? " (created)" : ""}; mirror seeded at ${outcome.result.initialPush.commitOid?.slice(0, 7)}.`,
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not link."),
  });

  if (connections.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Back this repo with GitHub by connecting a GitHub account on the{" "}
        {params.projectSlug === undefined ? (
          "integrations page"
        ) : (
          <Link
            className="underline underline-offset-2"
            to="/projects/$projectSlug/integrations"
            params={{ projectSlug: params.projectSlug }}
          >
            integrations page
          </Link>
        )}
        , then linking a repository here.
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (connection === "" || selected === null) return;
        link.mutate();
      }}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Back this repo with GitHub
      </span>
      <p className="text-xs text-muted-foreground">
        Pick a repository the GitHub App can see. Linking pulls from GitHub by default; commits then
        mirror out and webhooks land on this repo&apos;s stream.
      </p>
      {connections.length > 1 ? (
        <NativeSelect
          size="sm"
          className="w-full"
          value={connection}
          onChange={(event) => {
            setConnection(event.target.value);
            setSelected(null);
          }}
        >
          {connections.map((name) => (
            <NativeSelectOption key={name} value={name}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <span className="text-xs text-muted-foreground">via {connection}</span>
      )}
      {connection === "" ? null : (
        <Suspense
          fallback={
            <div
              className="rounded-md border p-2 text-xs text-muted-foreground"
              data-spinner="true"
            >
              Loading repositories…
            </div>
          }
        >
          <InstallationRepoPicker
            connection={connection}
            projectId={projectId}
            selected={selected}
            onSelect={setSelected}
            dense
            filterPlaceholder="Filter repositories…"
          />
        </Suspense>
      )}
      <Button
        type="submit"
        size="sm"
        className="text-xs"
        disabled={link.isPending || connection === "" || selected === null}
      >
        {link.isPending ? "Linking…" : selected === null ? "Pick a repository" : "Link to GitHub"}
      </Button>
    </form>
  );
}

function HistoryResolutionStep({
  reason,
  defaultChoice,
  busy,
  onCancel,
  onConfirm,
}: {
  reason: string;
  defaultChoice: GithubHistoryResolutionChoice;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: GithubHistoryResolutionChoice) => void;
}) {
  const [choice, setChoice] = useState<GithubHistoryResolutionChoice>(defaultChoice);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="github-history-resolution">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Histories diverged
        </span>
        <p className="text-xs text-muted-foreground">
          GitHub and this project both have commits the other side is missing. Choose how to
          reconcile — default is to pull GitHub&apos;s version into the project.
        </p>
        <p className="break-all text-[11px] text-muted-foreground/80">{reason}</p>
      </div>
      <div
        className="flex flex-col gap-1.5"
        role="radiogroup"
        aria-label="How to reconcile GitHub history"
      >
        {GITHUB_HISTORY_RESOLUTION_OPTIONS.map((option) => {
          const selected = choice === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => setChoice(option.value)}
              className={cn(
                "flex flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                selected ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/40",
                busy && "opacity-60",
              )}
            >
              <span className="text-xs font-medium">
                {option.label}
                {option.default ? (
                  <span className="ml-1 font-normal text-muted-foreground">(recommended)</span>
                ) : null}
              </span>
              <span className="text-[11px] leading-snug text-muted-foreground">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        <Button size="sm" className="text-xs" disabled={busy} onClick={() => onConfirm(choice)}>
          {busy
            ? choice === "agent"
              ? "Starting agent…"
              : choice === "push"
                ? "Force pushing…"
                : "Pulling…"
            : choice === "agent"
              ? "Start merge agent"
              : choice === "push"
                ? "Force push to GitHub"
                : "Use GitHub's version"}
        </Button>
        <Button size="sm" variant="outline" className="text-xs" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
