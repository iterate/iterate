import { Suspense, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@iterate-com/ui/components/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { toast } from "@iterate-com/ui/components/sonner";
import { useItx, useItxQuery, type ItxReactHandle } from "~/itx/itx-react.tsx";

const REPO_PATH_PATTERN = /^\/repos\/.+$/;

/** How many 100-repo pages to pull from the installation before cutting off —
 * a picker, not a mirror of the whole org. */
const MAX_INSTALLATION_REPO_PAGES = 5;

type InstallationRepo = {
  defaultBranch: string;
  fullName: string;
  name: string;
  owner: string;
  pushedAt: string | null;
};

/** The slice of GitHub's installation-repositories page the picker reads. */
type GithubInstallationReposPage = {
  data: {
    repositories: Array<{
      default_branch: string;
      full_name: string;
      name: string;
      owner: { login: string };
      pushed_at: string | null;
    }>;
    total_count: number;
  };
};

/**
 * Every repository the connection's GitHub App installation can see (its
 * "selected repositories" set — an unselected repo simply isn't in this list),
 * most recently pushed first. `invokeCapability` is the typed spelling of the
 * dotted `itx.integrations.github[<connection>].rest...` surface. A GitHub
 * failure is returned as data, not thrown: the caller reads through a
 * suspense query, and a throw there would take down the whole repos page
 * instead of one panel of the dialog.
 */
async function listInstallationRepos(
  itx: ItxReactHandle,
  connection: string,
): Promise<{ error: string | null; repos: InstallationRepo[]; totalCount: number }> {
  const repos: InstallationRepo[] = [];
  let totalCount = 0;
  let error: string | null = null;
  for (let page = 1; page <= MAX_INSTALLATION_REPO_PAGES; page++) {
    let response: GithubInstallationReposPage;
    try {
      response = (await itx.integrations.invokeCapability({
        args: [{ page, per_page: 100 }],
        path: ["github", connection, "rest", "apps", "listReposAccessibleToInstallation"],
      })) as GithubInstallationReposPage;
    } catch (caught) {
      // A later page's failure keeps what earlier pages returned: a partial
      // list with a warning beats discarding fetched repositories.
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
    totalCount = response.data.total_count;
    repos.push(
      ...response.data.repositories.map((repo) => ({
        defaultBranch: repo.default_branch,
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        pushedAt: repo.pushed_at,
      })),
    );
    if (response.data.repositories.length === 0 || repos.length >= totalCount) break;
  }
  repos.sort((left, right) => (right.pushedAt ?? "").localeCompare(left.pushedAt ?? ""));
  return { error, repos, totalCount: Math.max(totalCount, repos.length) };
}

/**
 * "Add from GitHub" on the repos page: a small wizard that creates a project
 * repo backed by a repository picked from the project's GitHub connection —
 * create, link (mirror-out + webhook cross-post), then adopt GitHub's `main`
 * head so the new repo starts as a copy of the GitHub one. Renders nothing
 * when the project has no GitHub connection. Suspends on the connections
 * read — mount under a `<Suspense>` boundary.
 *
 * `existingRepoPaths` (the page's live repo list) gates the path field:
 * `repos.create` is create-if-absent, so without the gate an existing path —
 * `/repos/config` included — would be silently linked and force-synced,
 * discarding its local history. `undefined` means the list has not arrived
 * yet, and the gate stays CLOSED (submit disabled): an unknown list must not
 * read as "every path is free".
 */
export function AddRepoFromGithub({
  projectId,
  existingRepoPaths,
  onAdded,
}: {
  projectId: string;
  existingRepoPaths: string[] | undefined;
  onAdded: (path: string) => void;
}) {
  const connections = useItxQuery({
    key: ["github-connections", projectId],
    query: async (itx) => {
      // Failures come back as data (an empty list, so the row simply doesn't
      // render): this is optional sugar on the repos page, and a throw from a
      // suspense query would take down the whole page, not just the button.
      try {
        const entries = await itx.integrations.list();
        // Only builtin GitHub connections can back a repo (they carry the App
        // installation the mirror pushes authenticate through).
        return entries.flatMap((entry) =>
          entry.source === "builtin" && entry.integration === "github" ? [entry.connection] : [],
        );
      } catch (error) {
        console.error("AddRepoFromGithub: listing integrations failed", error);
        return [];
      }
    },
  });
  const [open, setOpen] = useState(false);
  if (connections.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <p className="text-sm text-muted-foreground">
        Or add an existing repository from your GitHub account.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
          Add from GitHub
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a repo from GitHub</DialogTitle>
            <DialogDescription>
              Creates a project repo linked to the GitHub repository and pulls its{" "}
              <span className="font-mono">main</span> branch. From then on commits mirror out
              automatically and GitHub webhooks about the repository land on the repo's stream.
            </DialogDescription>
          </DialogHeader>
          <AddRepoFromGithubWizard
            connections={connections}
            existingRepoPaths={existingRepoPaths}
            onAdded={(path) => {
              setOpen(false);
              onAdded(path);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddRepoFromGithubWizard({
  connections,
  existingRepoPaths,
  onAdded,
}: {
  connections: string[];
  existingRepoPaths: string[] | undefined;
  onAdded: (path: string) => void;
}) {
  const itx = useItx();
  const [connection, setConnection] = useState(connections[0] ?? "");
  const [selected, setSelected] = useState<InstallationRepo | null>(null);
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("/repos/");
  // Once the user edits the path by hand, picking a different repository
  // stops overwriting it.
  const [pathEdited, setPathEdited] = useState(false);
  // Paths THIS wizard created. A failed linkGithub leaves the dialog open for
  // a retry, but by then the just-created repo is in the live list — without
  // this exemption the taken-path gate would block the very retry the
  // idempotent create→link→sync flow is built for. Fresh seed only, so the
  // force-sync stays safe; closing the dialog drops the exemption and the
  // repo page's GitHub panel is the repair path from there.
  const [createdHere, setCreatedHere] = useState<ReadonlySet<string>>(new Set());
  const normalizedPath = path.trim();
  // undefined = the live repo list has not arrived yet: the gate stays
  // CLOSED (submit disabled) rather than treating every path as free.
  const pathsKnown = existingRepoPaths !== undefined;
  const pathTaken =
    existingRepoPaths !== undefined &&
    existingRepoPaths.includes(normalizedPath) &&
    !createdHere.has(normalizedPath);
  const pathFormatValid = REPO_PATH_PATTERN.test(normalizedPath);
  const pathValid = pathFormatValid && pathsKnown && !pathTaken;

  const addRepo = useMutation({
    mutationFn: async (input: { path: string; repo: InstallationRepo }) => {
      // The wizard only ADDS repos. `repos.create` is create-if-absent, so an
      // existing path would sail through and the force-sync below would
      // discard its history — re-check against the live list right before
      // mutating (the submit gate can race a repo created since last render).
      if (existingRepoPaths === undefined) {
        throw new Error("The project's repo list has not loaded yet; try again in a moment.");
      }
      if (existingRepoPaths.includes(input.path) && !createdHere.has(input.path)) {
        throw new Error(
          `${input.path} already exists. To back an existing repo with GitHub, use the GitHub panel on that repo's page.`,
        );
      }
      // create is "create if it does not exist yet", so a retry after a
      // mid-flow failure is safe and finishes the job.
      await itx.repos.create({ path: input.path });
      setCreatedHere((previous) => new Set(previous).add(input.path));
      const repo = itx.repos.get(input.path);
      const link = await repo.linkGithub({
        connection,
        owner: input.repo.owner,
        repo: input.repo.name,
      });
      // Adopt GitHub's main. force: the fresh repo's starter seed is history
      // GitHub has never seen — GitHub wins. An empty GitHub repository has
      // nothing to adopt: the link's initial push already seeded it, and the
      // sync reports changed: false.
      let sync: { changed: boolean; commitOid: string } | null = null;
      let syncError: string | null = null;
      try {
        sync = await repo.syncFromGithub({ force: true });
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
      }
      return { link, path: input.path, sync, syncError };
    },
    onSuccess: (result, variables) => {
      const github = `${result.link.owner}/${result.link.repo}`;
      if (result.syncError !== null) {
        toast.warning(
          `${result.path} is linked to ${github}, but pulling main failed: ${result.syncError} Use "Sync from GitHub" in the repo's GitHub panel to retry.`,
        );
      } else if (result.sync?.changed) {
        toast.success(
          `Added ${result.path} from ${github} at ${result.sync.commitOid.slice(0, 7)}.`,
        );
      } else if (result.link.initialPush.ok) {
        // changed: false right after a successful seed push means GitHub had
        // no main HEAD to pull — either an empty repository, or one whose
        // content lives on a different default branch (which iterate does not
        // mirror). Only claim what we know.
        toast.success(
          variables.repo.defaultBranch === "main"
            ? `Added ${result.path} linked to ${github} — the GitHub repository had no main branch to pull, so it was seeded with the starter files.`
            : `Added ${result.path} linked to ${github} — its content lives on "${variables.repo.defaultBranch}", which iterate does not mirror, so main was seeded with the starter files.`,
        );
      } else {
        toast.success(`Added ${result.path} linked to ${github}.`);
      }
      onAdded(result.path);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not add the repo.");
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected === null || !pathValid || addRepo.isPending) return;
        addRepo.mutate({ path: normalizedPath, repo: selected });
      }}
    >
      {connections.length > 1 ? (
        <Field>
          <FieldLabel htmlFor="add-repo-github-connection">Connection</FieldLabel>
          <NativeSelect
            id="add-repo-github-connection"
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
        </Field>
      ) : null}

      <Field>
        <FieldLabel htmlFor="add-repo-github-filter">Repository</FieldLabel>
        <Input
          id="add-repo-github-filter"
          placeholder="Filter repositories…"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <Suspense
          fallback={
            <div
              className="rounded-md border p-3 text-sm text-muted-foreground"
              data-spinner="true"
            >
              Loading repositories…
            </div>
          }
        >
          <InstallationRepoList
            connection={connection}
            filter={filter}
            selected={selected}
            onSelect={(repo) => {
              setSelected(repo);
              if (!pathEdited) setPath(`/repos/${repo.name}`);
            }}
          />
        </Suspense>
      </Field>

      {/* Error blame is split: format problems name the format, a taken path
          names the collision, and a still-loading repo list shows NO error —
          the closed gate only holds the submit button, it is not the user's
          fault. */}
      <Field data-invalid={(pathTaken || !pathFormatValid) && path !== "/repos/"}>
        <FieldLabel htmlFor="add-repo-github-path">Path</FieldLabel>
        <Input
          id="add-repo-github-path"
          placeholder="/repos/project"
          value={path}
          onChange={(event) => {
            setPath(event.currentTarget.value);
            setPathEdited(true);
          }}
          aria-invalid={(pathTaken || !pathFormatValid) && path !== "/repos/"}
        />
        <FieldDescription>
          {pathsKnown
            ? "Project-local repo path."
            : "Project-local repo path (loading the repo list…)."}
        </FieldDescription>
        {pathTaken ? (
          <FieldError>
            {normalizedPath} already exists. To back an existing repo with GitHub, use the GitHub
            panel on that repo's page.
          </FieldError>
        ) : !pathFormatValid && path !== "/repos/" ? (
          <FieldError>Use a repo path like "/repos/project".</FieldError>
        ) : null}
      </Field>

      <DialogFooter showCloseButton>
        <Button
          type="submit"
          size="sm"
          disabled={selected === null || !pathValid || addRepo.isPending}
        >
          {addRepo.isPending ? "Adding…" : "Add repo"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function InstallationRepoList({
  connection,
  filter,
  selected,
  onSelect,
}: {
  connection: string;
  filter: string;
  selected: InstallationRepo | null;
  onSelect: (repo: InstallationRepo) => void;
}) {
  const { error, repos, totalCount } = useItxQuery({
    key: ["github-installation-repos", connection],
    query: (itx) => listInstallationRepos(itx, connection),
  });
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query === "") return repos;
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  }, [filter, repos]);

  if (error !== null && repos.length === 0) {
    return (
      <div className="break-words rounded-md border p-3 text-sm text-red-600">
        Could not list repositories through connection "{connection}": {error}
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        The GitHub App installation on "{connection}" has access to no repositories. Grant it
        repository access on GitHub, then reopen this dialog.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="max-h-56 overflow-y-auto rounded-md border p-1">
        {visible.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No repositories match.</div>
        ) : (
          visible.map((repo) => {
            const isSelected = selected?.fullName === repo.fullName;
            return (
              <button
                key={repo.fullName}
                type="button"
                className={`flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent ${isSelected ? "bg-accent" : ""}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(repo)}
              >
                <span className="min-w-0 truncate font-mono text-xs">{repo.fullName}</span>
                {repo.defaultBranch !== "main" ? (
                  <span
                    className="shrink-0 text-xs text-muted-foreground"
                    title={`This repository's default branch is "${repo.defaultBranch}"; iterate pulls and mirrors "main".`}
                  >
                    default: {repo.defaultBranch}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      {error !== null ? (
        <p className="break-words text-xs text-red-600">
          Listing stopped early — showing the {repos.length} repositories fetched so far: {error}
        </p>
      ) : repos.length < totalCount ? (
        <p className="text-xs text-muted-foreground">
          Showing {repos.length} of {totalCount} repositories the installation can see.
        </p>
      ) : null}
    </div>
  );
}
