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
import { useItx, useItxQuery } from "iterate/sdk/itx/react";
import {
  assertInstallationRepoCanBeCreated,
  githubRepoCreateRequest,
  listGithubConnections,
  type InstallationRepo,
} from "~/components/github-installation-repos.ts";
import { InstallationRepoList } from "~/components/github-installation-repos.tsx";

const REPO_PATH_PATTERN = /^\/repos\/.+$/;

/**
 * "Add from GitHub" on the repos page: a small wizard that creates a project
 * repo backed by a repository picked from the project's GitHub connection.
 * The repo creation saga imports public history through Cloudflare Artifacts
 * and adopts private repos through a depth-one Worker sync. Renders nothing
 * when the project has no GitHub connection. Suspends on the connections
 * read — mount under a `<Suspense>` boundary.
 *
 * `existingRepoPaths` (the page's live repo list) gates the path field:
 * `repo.create` is create-if-absent, so without the gate an existing path
 * could receive a conflicting creation request. `undefined` means the list has not arrived
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
  if (!connections.length) return null;

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
  // Paths claimed by this wizard. This keeps a retry available if the same
  // durable creation saga fails after its request has been committed.
  const [createdHere, setCreatedHere] = useState<ReadonlySet<string>>(new Set());
  const normalizedPath = path.trim();
  // undefined = the live repo list has not arrived yet: the gate stays
  // CLOSED (submit disabled) rather than treating every path as free.
  const pathsKnown = !!existingRepoPaths;
  const pathTaken =
    !!existingRepoPaths &&
    existingRepoPaths.includes(normalizedPath) &&
    !createdHere.has(normalizedPath);
  const pathFormatValid = REPO_PATH_PATTERN.test(normalizedPath);
  const pathValid = pathFormatValid && pathsKnown && !pathTaken;

  const addRepo = useMutation({
    mutationFn: async (input: { path: string; repo: InstallationRepo }) => {
      // The wizard only ADDS repos. Re-check against the live list right
      // before mutating: the submit gate can race a repo created since the
      // last render.
      if (!existingRepoPaths) {
        throw new Error("The project's repo list has not loaded yet; try again in a moment.");
      }
      if (existingRepoPaths.includes(input.path) && !createdHere.has(input.path)) {
        throw new Error(
          `${input.path} already exists. To back an existing repo with GitHub, use the GitHub panel on that repo's page.`,
        );
      }
      assertInstallationRepoCanBeCreated(input.repo);
      // Claim the path for this wizard instance before the create round-trip
      // so a retry can resume the same durable request after a failed call.
      setCreatedHere((previous) => new Set(previous).add(input.path));
      // The request is the repo saga's durable identity, so a retry after a
      // mid-flow failure resumes the same creation rather than starting a
      // second orchestration path in the browser.
      await itx.repos.get(input.path).create(githubRepoCreateRequest(input.repo, connection));
    },
    onSuccess: (_, variables) => {
      const github = `${variables.repo.owner}/${variables.repo.name}`;
      toast.success(`Added ${variables.path} from ${github} at depth one.`);
      onAdded(variables.path);
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
        if (!selected || !pathValid || addRepo.isPending) return;
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
        <Button type="submit" size="sm" disabled={!selected || !pathValid || addRepo.isPending}>
          {addRepo.isPending ? "Adding…" : "Add repo"}
        </Button>
      </DialogFooter>
    </form>
  );
}
