import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import type { RepoProcessorState } from "../../domains/repos/repo-processor-contract.ts";
import { useItx, useItxQuery, useLiveState } from "~/itx/itx-react.tsx";

/**
 * The GitHub sidebar of the repo IDE: shows the repo's GitHub link (owner/
 * repo, connection, last mirror-push outcome) with push/sync/unlink actions,
 * or — when unlinked — a link form over the project's GitHub connections.
 * Once linked, commits mirror to GitHub automatically and GitHub webhooks
 * about the repository land on the repo's stream; the processor state is
 * live, so link and push facts fold into this panel as they happen.
 */
export function RepoGithubPanel({ projectId, repoPath }: { projectId: string; repoPath: string }) {
  const repoProcessor = useLiveState(
    (itx) => itx.repos.get(repoPath).liveState,
    (state) => state,
    [repoPath],
  );
  const state = repoProcessor.value;
  if (state === undefined) {
    return (
      <div className="p-3 text-xs text-muted-foreground" data-spinner="true">
        Loading…
      </div>
    );
  }
  return state.github === null ? (
    <LinkForm projectId={projectId} repoPath={repoPath} />
  ) : (
    <LinkedPanel repoPath={repoPath} github={state.github} lastPush={state.lastGithubPush} />
  );
}

function LinkedPanel({
  repoPath,
  github,
  lastPush,
}: {
  repoPath: string;
  github: NonNullable<RepoProcessorState["github"]>;
  lastPush: RepoProcessorState["lastGithubPush"];
}) {
  const itx = useItx();
  const push = useMutation({
    mutationFn: () => itx.repos.get(repoPath).pushToGithub({}),
    onSuccess: (result) => toast.success(`Pushed ${result.commitOid.slice(0, 7)} to GitHub.`),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Push failed."),
  });
  const sync = useMutation({
    mutationFn: () => itx.repos.get(repoPath).syncFromGithub({}),
    onSuccess: (result) =>
      toast.success(
        result.changed
          ? `Synced to GitHub's head ${result.commitOid.slice(0, 7)}.`
          : "Already at GitHub's head.",
      ),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Sync failed."),
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

function LinkForm({ projectId, repoPath }: { projectId: string; repoPath: string }) {
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
  const [connection, setConnection] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const link = useMutation({
    // Trimmed at the call, not just in the enable-check: a padded owner/repo
    // would store a link (and a full_name webhook condition) GitHub payloads
    // never match — mirroring would work while cross-post silently didn't.
    mutationFn: () =>
      itx.repos.get(repoPath).linkGithub({ connection, owner: owner.trim(), repo: repo.trim() }),
    onSuccess: (result) => {
      if (result.initialPush.ok) {
        toast.success(
          `Linked to ${result.owner}/${result.repo}${result.created ? " (created)" : ""}; mirror seeded at ${result.initialPush.commitOid?.slice(0, 7)}.`,
        );
      } else {
        toast.warning(
          `Linked to ${result.owner}/${result.repo}, but the initial push failed: ${result.initialPush.error}. Use "Sync from GitHub" to adopt its history, or "Push now" to retry.`,
        );
      }
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
        if (connection === "" || owner.trim() === "" || repo.trim() === "") return;
        link.mutate();
      }}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Back this repo with GitHub
      </span>
      <p className="text-xs text-muted-foreground">
        Commits mirror out automatically; GitHub webhooks about the repository land on this repo's
        stream. The repository is created (private) if missing and the installation can create org
        repositories.
      </p>
      <NativeSelect
        size="sm"
        className="w-full"
        value={connection}
        onChange={(event) => setConnection(event.target.value)}
      >
        <NativeSelectOption value="">Pick a connection…</NativeSelectOption>
        {connections.map((name) => (
          <NativeSelectOption key={name} value={name}>
            {name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Input
        placeholder="Owner (org)"
        className="h-8 text-xs"
        value={owner}
        onChange={(event) => setOwner(event.target.value)}
      />
      <Input
        placeholder="Repository"
        className="h-8 text-xs"
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        className="text-xs"
        disabled={link.isPending || connection === "" || owner.trim() === "" || repo.trim() === ""}
      >
        {link.isPending ? "Linking…" : "Link to GitHub"}
      </Button>
    </form>
  );
}
