import { Suspense, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import {
  Dialog,
  DialogClose,
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
import { useItx, useItxQuery } from "iterate/react";
import {
  listGithubConnections,
  type InstallationRepo,
} from "~/components/github-installation-repos.ts";
import { InstallationRepoList } from "~/components/github-installation-repos.tsx";

const REPO_PATH_PATTERN = /^\/repos\/.+$/;

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
    // Shared with the repo IDE GitHub panel — must never throw.
    query: (itx) => listGithubConnections(itx),
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
            projectId={projectId}
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
  projectId,
  existingRepoPaths,
  onAdded,
}: {
  connections: string[];
  projectId: string;
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
      // The wizard only ADDS repos. Re-check against the live list right
      // before mutating: the submit gate can race a repo created since the
      // last render.
      if (existingRepoPaths === undefined) {
        throw new Error("The project's repo list has not loaded yet; try again in a moment.");
      }
      if (existingRepoPaths.includes(input.path) && !createdHere.has(input.path)) {
        throw new Error(
          `${input.path} already exists. To back an existing repo with GitHub, use the GitHub panel on that repo's page.`,
        );
      }
      // Claim the path for this wizard instance BEFORE the create round-trip:
      // the live repo list records the path the moment the repo's stream is
      // born (its first append), seconds before create() resolves — without
      // the exemption already in place, the taken-path gate red-flags the very
      // repo this mutation is creating while it is still being seeded.
      setCreatedHere((previous) => new Set(previous).add(input.path));
      // createFromGithub records the source in the repo's birth certificate,
      // so a retry after a mid-flow failure is safe and finishes the job.
      return await itx.repos.createFromGithub({
        connection,
        owner: input.repo.owner,
        path: input.path,
        repo: input.repo.name,
      });
    },
    onSuccess: (result, variables) => {
      const github = `${result.link.owner}/${result.link.repo}`;
      if (result.imported) {
        toast.success(`Added ${result.path} from ${github} at depth one.`);
      } else if (result.syncError !== null) {
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
            projectId={projectId}
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

      {/* Close is hand-rolled rather than DialogFooter's showCloseButton:
          that one renders a type-less <button>, which inside this form
          defaults to type="submit" — Close would run the whole
          create→link→sync flow. */}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" size="sm" />}>
          Close
        </DialogClose>
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
