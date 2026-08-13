import { Suspense, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import { useItx, useItxQuery, useLiveState } from "iterate/sdk/itx/react";
import type { RepoProcessorState } from "../../domains/repos/repo-processor-contract.ts";
import {
  GITHUB_UI_FORCE_PULL_DEPTH,
  githubHistoryMergeAgentInstructions,
  githubHistoryMergeAgentPath,
  isGithubHistoryConflictError,
  preferredResolutionForSyncConflict,
} from "./github-history-resolution.ts";
import {
  listGithubConnections,
  type InstallationRepo,
} from "~/components/github-installation-repos.ts";
import { InstallationRepoPicker } from "~/components/github-installation-repos.tsx";

type Conflict = {
  owner: string;
  repo: string;
  reason: string;
  /** Pre-selected action: pull after connect/sync, push after push. */
  prefer: "pull" | "push";
};

/**
 * GitHub sidebar: link (picker + pull-first), push/sync/unlink, and a tiny
 * conflict step when histories diverge (force-pull / force-push / agent).
 */
export function RepoGithubPanel({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const itx = useItx();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectSlug?: string };
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const state = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (s) => s,
    [repoPath],
  ).value;

  const link = useMutation({
    mutationFn: async (input: { connection: string; owner: string; repo: string }) => {
      const repo = itx.repos.get(repoPath);
      // linkGithub persists the link before this returns. After it resolves we
      // never throw — live state already shows LinkedPanel; a throw would toast
      // "could not link" while the repo is linked.
      const result = await repo.linkGithub(input);
      try {
        const sync = await repo.syncFromGithub({});
        return { kind: "ok" as const, result, sync };
      } catch (e) {
        if (isGithubHistoryConflictError(e)) {
          return {
            kind: "conflict" as const,
            result,
            reason: e instanceof Error ? e.message : String(e),
          };
        }
        return {
          kind: "linked" as const,
          result,
          warning: e instanceof Error ? e.message : String(e),
        };
      }
    },
    onSuccess: (out) => {
      if (out.kind === "conflict") {
        setConflict({
          owner: out.result.owner,
          repo: out.result.repo,
          reason: out.reason,
          prefer: preferredResolutionForSyncConflict(out.reason),
        });
        return;
      }
      const name = `${out.result.owner}/${out.result.repo}`;
      if (out.kind === "ok" && out.sync.changed) {
        toast.success(`Linked ${name} at ${out.sync.commitOid.slice(0, 7)}.`);
        return;
      }
      if (out.kind === "linked") {
        toast.warning(
          `Linked ${name}, but pulling from GitHub failed: ${out.warning} Use Sync from GitHub or Push now.`,
        );
        return;
      }
      toast.success(`Linked ${name}.`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not link."),
  });

  const resolve = useMutation({
    mutationFn: async (choice: "pull" | "push" | "agent") => {
      if (!conflict) throw new Error("Nothing to resolve.");
      const repo = itx.repos.get(repoPath);
      if (choice === "pull") {
        return {
          kind: "pull" as const,
          r: await repo.syncFromGithub({ force: true, depth: GITHUB_UI_FORCE_PULL_DEPTH }),
        };
      }
      if (choice === "push") {
        return { kind: "push" as const, r: await repo.pushToGithub({ force: true }) };
      }
      const agentPath = githubHistoryMergeAgentPath(repoPath);
      const agent = itx.agents.get(agentPath);
      const snapshot = await agent.processor.snapshot();
      if (!snapshot.state.birthCertificate) await agent.create();
      await agent.message(
        githubHistoryMergeAgentInstructions({
          owner: conflict.owner,
          repo: conflict.repo,
          repoPath,
        }),
      );
      return { kind: "agent" as const, agentPath };
    },
    onSuccess: (out) => {
      setConflict(null);
      if (out.kind === "pull") {
        toast.success(
          out.r.changed
            ? `Now at GitHub's ${out.r.commitOid.slice(0, 7)}.`
            : "Already at GitHub's head.",
        );
      } else if (out.kind === "push") {
        toast.success(`Force-pushed ${out.r.commitOid.slice(0, 7)}.`);
      } else if (params.projectSlug) {
        toast.success("Started merge agent.");
        void navigate({
          to: "/projects/$projectSlug/agents/streams/$",
          params: { projectSlug: params.projectSlug, _splat: out.agentPath },
          search: {},
        });
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Resolve failed."),
  });

  if (!state) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
        Loading…
      </div>
    );
  }
  if (conflict) {
    return (
      <ConflictStep
        prefer={conflict.prefer}
        reason={conflict.reason}
        busy={resolve.isPending}
        onCancel={() => setConflict(null)}
        onPick={(c) => resolve.mutate(c)}
      />
    );
  }
  // Don't swap to LinkedPanel while link→pull is mid-flight.
  if (link.isPending) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
        Linking and pulling from GitHub…
      </div>
    );
  }
  if (!state.github) {
    return (
      <LinkForm
        projectId={projectId}
        onLink={(input) => link.mutate(input)}
        busy={link.isPending}
      />
    );
  }
  return (
    <LinkedPanel
      repoPath={repoPath}
      github={state.github}
      lastPush={state.lastGithubPush}
      onConflict={setConflict}
    />
  );
}

function LinkedPanel({
  repoPath,
  github,
  lastPush,
  onConflict,
}: {
  repoPath: string;
  github: NonNullable<RepoProcessorState["github"]>;
  lastPush: RepoProcessorState["lastGithubPush"];
  onConflict: (c: Conflict) => void;
}) {
  const itx = useItx();
  const push = useMutation({
    mutationFn: () => itx.repos.get(repoPath).pushToGithub({}),
    onSuccess: (r) => toast.success(`Pushed ${r.commitOid.slice(0, 7)}.`),
    onError: (e) => {
      if (isGithubHistoryConflictError(e)) {
        onConflict({
          owner: github.owner,
          repo: github.repo,
          prefer: "push",
          reason: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      toast.error(e instanceof Error ? e.message : "Push failed.");
    },
  });
  const sync = useMutation({
    mutationFn: () => itx.repos.get(repoPath).syncFromGithub({}),
    onSuccess: (r) =>
      toast.success(r.changed ? `Synced ${r.commitOid.slice(0, 7)}.` : "Already at GitHub's head."),
    onError: (e) => {
      if (isGithubHistoryConflictError(e)) {
        const reason = e instanceof Error ? e.message : String(e);
        onConflict({
          owner: github.owner,
          repo: github.repo,
          prefer: preferredResolutionForSyncConflict(reason),
          reason,
        });
        return;
      }
      toast.error(e instanceof Error ? e.message : "Sync failed.");
    },
  });
  const unlink = useMutation({
    mutationFn: () => itx.repos.get(repoPath).unlinkGithub(),
    onSuccess: () => toast.success("Unlinked."),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Unlink failed."),
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
        {!lastPush ? (
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
  onLink,
  busy,
}: {
  projectId: string;
  onLink: (input: { connection: string; owner: string; repo: string }) => void;
  busy: boolean;
}) {
  const params = useParams({ strict: false }) as { projectSlug?: string };
  const connections = useItxQuery({
    key: ["github-connections", projectId],
    query: (itx) => listGithubConnections(itx),
  });
  const [connection, setConnection] = useState(connections[0] ?? "");
  const [selected, setSelected] = useState<InstallationRepo | null>(null);

  if (!connections.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Connect GitHub on the{" "}
        {params.projectSlug ? (
          <Link
            className="underline underline-offset-2"
            to="/projects/$projectSlug/integrations"
            params={{ projectSlug: params.projectSlug }}
          >
            integrations page
          </Link>
        ) : (
          "integrations page"
        )}
        , then link a repository here.
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!connection || !selected || busy) return;
        onLink({ connection, owner: selected.owner, repo: selected.name });
      }}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Back this repo with GitHub
      </span>
      <p className="text-xs text-muted-foreground">
        Pick a repo the App can see. Linking pulls from GitHub by default.
      </p>
      {connections.length > 1 ? (
        <NativeSelect
          size="sm"
          className="w-full"
          value={connection}
          onChange={(e) => {
            setConnection(e.target.value);
            setSelected(null);
          }}
        >
          {connections.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {c}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <span className="text-xs text-muted-foreground">via {connection}</span>
      )}
      {connection ? (
        <Suspense
          fallback={
            <div className="text-xs text-muted-foreground" data-spinner="true">
              Loading repositories…
            </div>
          }
        >
          {/* key remounts the picker so filter text does not stick across connections */}
          <InstallationRepoPicker
            key={connection}
            connection={connection}
            projectId={projectId}
            selected={selected}
            onSelect={setSelected}
          />
        </Suspense>
      ) : null}
      <Button type="submit" size="sm" className="text-xs" disabled={busy || !selected}>
        {busy ? "Linking…" : selected ? "Link to GitHub" : "Pick a repository"}
      </Button>
    </form>
  );
}

/** Three actions — no radio chrome. Default button is the recommended path. */
function ConflictStep({
  prefer,
  reason,
  busy,
  onCancel,
  onPick,
}: {
  prefer: "pull" | "push";
  reason: string;
  busy: boolean;
  onCancel: () => void;
  onPick: (c: "pull" | "push" | "agent") => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="github-history-resolution">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Histories diverged
      </span>
      <p className="text-xs text-muted-foreground">
        {prefer === "pull"
          ? "Default: replace this project with GitHub's main (discards project-only commits)."
          : "Default: force-push this project to GitHub (overwrites remote)."}
      </p>
      <p className="break-all text-[11px] text-muted-foreground/80">{reason}</p>
      <Button
        size="sm"
        variant="destructive"
        className="text-xs"
        disabled={busy}
        onClick={() => onPick(prefer)}
      >
        {busy
          ? prefer === "pull"
            ? "Pulling…"
            : "Force pushing…"
          : prefer === "pull"
            ? "Use GitHub's version"
            : "Force push to GitHub"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-xs"
        disabled={busy}
        onClick={() => onPick(prefer === "pull" ? "push" : "pull")}
      >
        {prefer === "pull" ? "Force push to GitHub instead" : "Use GitHub's version instead"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-xs"
        disabled={busy}
        onClick={() => onPick("agent")}
      >
        {busy ? "Starting…" : "Ask an agent to merge"}
      </Button>
      <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
