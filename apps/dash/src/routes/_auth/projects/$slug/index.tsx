// /projects/<project>/ — the overview: the project, its role, its site — and, while the project's own
// creation runs, where it stands: the `project` facet's LIVE STATE on `/` (apps/os/src/project/),
// rendered as a creation checklist until `project/created` lands, or as the failure the
// processor reported. The frame the project's own pages fill in over time. Its organization's owner
// deletes the project here (`session.projects.delete`). The config repo's remote is linked, pulled
// and pushed here too (`itx.repos.get("/repos/config")`: `origin`, `setOrigin`, `pull`, `push`).
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, CheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import { errorCode } from "iterate/lib";
import { useContextStub, useFacetLiveState } from "iterate/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@iterate-com/ui/components/alert-dialog";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button, buttonVariants } from "@iterate-com/ui/components/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { cn } from "cn";
import { Identifier } from "../../../../components/identifier.tsx";
import {
  reloadOrganizationTree,
  useOrganizationTree,
} from "../../../../components/organization-tree.tsx";
import { projectHostOf } from "../../../../lib/origins.ts";

const shell = getRouteApi("/_auth");

/** The project facet's live state, the fields this page reads: where the project's own creation
 *  stands, as the offset of the event that says so (null until `project/create-requested` lands). */
const ProjectLive = z.looseObject({
  creation: z
    .object({ status: z.enum(["requested", "created", "failed"]), offset: z.number() })
    .nullable(),
  /** the catalog's repos, by path: the seeded config repo is the saga's first visible step */
  repos: z.record(z.string(), z.unknown()),
  /** the project's connections: its GitHub ones list the repositories the config repo can link to */
  integrations: z
    .record(
      z.string(),
      z.looseObject({ provider: z.string(), connection: z.string(), account: z.string() }),
    )
    .default({}),
});

export const Route = createFileRoute("/_auth/projects/$slug/")({
  validateSearch: z.object({
    /** The sheet that links the config repo to a remote. */
    configRepo: z.literal("link").optional().catch(undefined),
  }),
  component: ProjectOverview,
});

function ProjectOverview() {
  const { project } = Route.useRouteContext();
  const { api, info } = shell.useRouteContext();
  // its organization — the name and the person's role — from the tree, live
  const org = useOrganizationTree().organizations.find(
    (candidate) => candidate.id === project.orgId,
  );
  const host = projectHostOf(info, project.slug);
  // the project's root context, held for the page's life; the route resolved the project already,
  // so a refusal leaves the plain overview
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]).stub;
  const live = useFacetLiveState(context, "project");
  const parsed = ProjectLive.safeParse(live.value).data;
  const creation = parsed?.creation ?? null;
  const configRepoSeeded = Boolean(parsed?.repos["/repos/config"]);
  const githubConnections = Object.values(parsed?.integrations ?? {}).filter(
    (row) => row.provider === "github",
  );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:p-8">
      {creation?.status === "requested" ? (
        <ProjectCreationProgress configRepoSeeded={configRepoSeeded} />
      ) : null}
      {creation?.status === "failed" && context ? (
        <ProjectCreationFailed context={context} offset={creation.offset} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{project.slug}</h1>
          {org?.role ? <Badge variant="secondary">{org.role}</Badge> : null}
        </div>
        {host ? (
          <a
            href={host}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Open {new URL(host).host}
            <ArrowUpRight />
          </a>
        ) : null}
      </div>
      {/* the ids, copyable: the project's, and its organization's beside the name */}
      <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Project id</dt>
        <dd>
          <Identifier value={project.id} />
        </dd>
        <dt className="text-muted-foreground">Organization</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {org ? <span>{org.name}</span> : null}
          <Identifier value={project.orgId} />
        </dd>
      </dl>
      {/* a project still being created, or whose creation failed, may have no config repo yet */}
      {creation?.status === "requested" || creation?.status === "failed" ? null : (
        <ConfigRepo project={project} githubConnections={githubConnections} />
      )}
      {org?.role === "owner" ? <DeleteProject project={project} /> : null}
    </div>
  );
}

/** What the config repo's section is doing: one action at a time. */
type ConfigRepoAction = "link" | "pull" | "push" | "replace" | "force-push" | "unlink";

/** `NOT_FAST_FORWARD`'s data: each main's tip. */
const DivergedTips = z.object({ ours: z.string(), theirs: z.string() });
type Diverged = { verb: "pull" | "push"; tips?: z.infer<typeof DivergedTips> };

/** The config repo's remote, git's `origin`: read once (`origin()`), then kept from what `setOrigin`
 *  answers. Linking is a sheet (`?configRepo=link`) that sets the origin, then pulls. A pull or push
 *  that is not a fast-forward opens the sheet on the choice: keep the remote's main (a forced pull)
 *  or iterate's (a forced push), or leave both as they are. */
function ConfigRepo({
  project,
  githubConnections,
}: {
  project: { id: string; slug: string };
  githubConnections: { connection: string; account: string }[];
}) {
  const { api } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [read, setRead] = useState<{ origin: string | null }>();
  const [busy, setBusy] = useState<ConfigRepoAction | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diverged, setDiverged] = useState<Diverged | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let disposed = false;
    api.projects
      .get(project.id)
      .repos.get("/repos/config")
      .origin()
      .then(
        (origin) => !disposed && setRead({ origin }),
        (caught: unknown) =>
          !disposed && setError(caught instanceof Error ? caught.message : String(caught)),
      );
    return () => {
      disposed = true;
    };
  }, [api, project.id]);

  const configRepo = () => api.projects.get(project.id).repos.get("/repos/config");
  const described = read?.origin ? describeOrigin(read.origin) : null;
  const remote = described?.remote ?? "GitHub";
  const sheetOpen = search.configRepo === "link" || Boolean(diverged);
  const closeSheet = async () => {
    setError(null);
    setDiverged(null);
    await navigate({ search: {}, replace: true });
  };
  const run = async (action: ConfigRepoAction, work: () => Promise<void>) => {
    setError(null);
    setOutcome(null);
    setBusy(action);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  /** Pull or push main: the outcome shown and the sheet closed, or, when the two mains have
   *  diverged, the sheet open on the choice. */
  const sync = async (verb: "pull" | "push", options?: { force: true }) => {
    try {
      const result = await (verb === "pull"
        ? configRepo().pull(options)
        : configRepo().push(options));
      setOutcome(
        result.status === "up-to-date"
          ? "Already up to date"
          : `${verb === "pull" ? "Pulled" : "Pushed"} ${(result.commitOid || "").slice(0, 7)}`,
      );
      await closeSheet();
    } catch (caught) {
      if (errorCode(caught) !== "NOT_FAST_FORWARD") throw caught;
      setDiverged({ verb, tips: z.object({ data: DivergedTips }).safeParse(caught).data?.data });
    }
  };

  return (
    <section aria-labelledby="config-repo-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="config-repo-heading" className="text-lg font-semibold tracking-tight">
            Config repo
          </h2>
          <p className="text-sm text-muted-foreground">
            The project&apos;s code, <code>/repos/config</code>: every commit to its main publishes.
            Link it to a git remote to pull that main in and push it back.
          </p>
        </div>
        {read ? (
          <div className="flex flex-wrap gap-2">
            {described ? (
              <>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void run("pull", () => sync("pull"))}
                >
                  {busy === "pull" ? <Spinner data-icon="inline-start" /> : null}
                  Pull now
                </Button>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void run("push", () => sync("push"))}
                >
                  {busy === "push" ? <Spinner data-icon="inline-start" /> : null}
                  Push now
                </Button>
                <ReplaceWithRemote
                  remote={remote}
                  variant="outline"
                  busy={busy}
                  onReplace={() => run("replace", () => sync("pull", { force: true }))}
                >
                  Replace with {remote}&apos;s
                </ReplaceWithRemote>
                <Button
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run("unlink", async () => setRead(await configRepo().setOrigin(null)))
                  }
                >
                  {busy === "unlink" ? <Spinner data-icon="inline-start" /> : null}
                  Unlink
                </Button>
              </>
            ) : (
              <Button
                disabled={Boolean(busy)}
                onClick={() => void navigate({ search: { configRepo: "link" } })}
              >
                Link
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {!read && !error ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {read && !described ? <p className="text-sm text-muted-foreground">Not linked</p> : null}
      {described ? (
        <p className="text-sm">
          Linked to{" "}
          {described.href ? (
            <a
              href={described.href}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-4"
            >
              {described.label}
            </a>
          ) : (
            <code>{described.label}</code>
          )}
        </p>
      ) : null}
      {outcome ? (
        <p role="status" className="text-sm text-muted-foreground">
          {outcome}
        </p>
      ) : null}
      {error && !sheetOpen ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && !busy && void closeSheet()}>
        <SheetContent
          side="right"
          showCloseButton={!busy}
          initialFocus={diverged ? undefined : firstField}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          {diverged ? (
            <DivergedStep
              remote={remote}
              diverged={diverged}
              busy={busy}
              error={error}
              onReplace={() => run("replace", () => sync("pull", { force: true }))}
              onForcePush={() => run("force-push", () => sync("push", { force: true }))}
            />
          ) : search.configRepo === "link" ? (
            <LinkForm
              project={project}
              githubConnections={githubConnections}
              firstField={firstField}
              busy={busy}
              error={error}
              onLink={(url) =>
                run("link", async () => {
                  setRead(await configRepo().setOrigin(url));
                  await sync("pull");
                })
              }
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}

/** How an origin shows: a GitHub repository as `owner/repo`, linked to it, and any other remote as
 *  its URL. Either way without the userinfo, where a secret's placeholder sits (unencoded, it holds
 *  slashes, so the host starts after the last `@`). */
function describeOrigin(origin: string) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(origin)?.[0] ?? "";
  const rest = origin.slice(scheme.length);
  const bare = scheme + rest.slice(rest.lastIndexOf("@") + 1);
  const url = URL.parse(bare);
  const github =
    url?.host === "github.com" ? /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname) : null;
  if (!github) return { remote: url?.host || "the remote", label: bare, href: null };
  const [, owner, repo] = github;
  return {
    remote: "GitHub",
    label: `${owner}/${repo}`,
    href: `https://github.com/${owner}/${repo}`,
  };
}

/** Replace iterate's main with the remote's (a forced pull), once confirmed. */
function ReplaceWithRemote({
  remote,
  variant,
  busy,
  onReplace,
  children,
}: {
  remote: string;
  variant: "outline" | "destructive";
  busy: ConfigRepoAction | null;
  onReplace: () => Promise<void>;
  children: ReactNode;
}) {
  // AlertDialogAction is a plain button, and a replace from the section leaves this mounted: the
  // confirm closes the dialog itself
  const [confirming, setConfirming] = useState(false);
  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogTrigger render={<Button variant={variant} />} disabled={Boolean(busy)}>
        {busy === "replace" ? <Spinner data-icon="inline-start" /> : null}
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace iterate&apos;s main with {remote}&apos;s?</AlertDialogTitle>
          <AlertDialogDescription>
            iterate&apos;s own commits since the two diverged are dropped from main, and the project
            republishes {remote}&apos;s version.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              void onReplace();
            }}
          >
            Replace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The two mains have diverged: keep the remote's (after a link or a pull) or iterate's, or leave
 *  both as they are. */
function DivergedStep({
  remote,
  diverged,
  busy,
  error,
  onReplace,
  onForcePush,
}: {
  remote: string;
  diverged: Diverged;
  busy: ConfigRepoAction | null;
  error: string | null;
  onReplace: () => Promise<void>;
  onForcePush: () => Promise<void>;
}) {
  const tips = diverged.tips
    ? ` (iterate's is at ${diverged.tips.ours.slice(0, 7)}, ${remote}'s at ${diverged.tips.theirs.slice(0, 7)})`
    : "";
  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>{remote}&apos;s main and iterate&apos;s have diverged</SheetTitle>
        <SheetDescription>
          {`Each main has commits the other lacks${tips}. Keep one of them; Cancel keeps the link and moves nothing.`}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-6 p-4">
        {diverged.verb === "pull" ? (
          <div className="flex flex-col items-start gap-2">
            <ReplaceWithRemote
              remote={remote}
              variant="destructive"
              busy={busy}
              onReplace={onReplace}
            >
              Replace with {remote}&apos;s main
            </ReplaceWithRemote>
            <p className="text-sm text-muted-foreground">
              iterate&apos;s main becomes {remote}&apos;s, and the project republishes it.
            </p>
          </div>
        ) : null}
        <div className="flex flex-col items-start gap-2">
          <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void onForcePush()}>
            {busy === "force-push" ? <Spinner data-icon="inline-start" /> : null}
            {diverged.verb === "pull" ? `Push iterate's to ${remote}` : "Push iterate's anyway"}
          </Button>
          <p className="text-sm text-muted-foreground">
            {remote}&apos;s main becomes iterate&apos;s: its own commits since the two diverged are
            dropped from it.
          </p>
        </div>
        {error ? (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={Boolean(busy)} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
      </SheetFooter>
    </div>
  );
}

/** Link the config repo to a remote: a repository of one of the project's GitHub connections, or
 *  any public git URL over https. */
function LinkForm({
  project,
  githubConnections,
  firstField,
  busy,
  error,
  onLink,
}: {
  project: { id: string; slug: string };
  githubConnections: { connection: string; account: string }[];
  firstField: RefObject<HTMLInputElement | null>;
  busy: ConfigRepoAction | null;
  error: string | null;
  onLink: (url: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onLink(url);
  };
  return (
    <form onSubmit={submit} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>Link the config repo</SheetTitle>
        <SheetDescription>
          iterate keeps the remote as the repo&apos;s origin and pulls its main. Pull and push again
          from the project&apos;s page whenever you like.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        {githubConnections.length > 0 ? (
          githubConnections.map((row) => (
            <GithubRepositories
              key={row.connection}
              projectId={project.id}
              connection={row.connection}
              account={row.account}
              disabled={Boolean(busy)}
              onPick={onLink}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            Connect GitHub on{" "}
            <Link
              to="/projects/$slug/integrations"
              params={{ slug: project.slug }}
              className="underline underline-offset-4"
            >
              Integrations
            </Link>{" "}
            to pick one of its repositories, private ones included.
          </p>
        )}
        <Field>
          <FieldLabel htmlFor="config-repo-url">Git URL</FieldLabel>
          <Input
            id="config-repo-url"
            ref={firstField}
            type="url"
            required
            pattern="https://[^@]+"
            title="An https:// URL with no credentials in it"
            placeholder="https://github.com/acme/site.git"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={url}
            onChange={(event) => setUrl(event.target.value.trim())}
          />
          <FieldDescription>Any public git remote over https.</FieldDescription>
        </Field>
        {error ? (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={Boolean(busy)} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={Boolean(busy)}>
          {busy === "link" ? <Spinner data-icon="inline-start" /> : null}
          Link
        </Button>
      </SheetFooter>
    </form>
  );
}

/** GitHub's list of an installation's repositories, the one field read. */
const InstallationRepositories = z.object({
  repositories: z.array(z.object({ full_name: z.string() })),
});

/** What the project's egress swaps for a GitHub connection's installation token. */
function githubTokenPlaceholder(connection: string) {
  return `getSecret("/secrets/github-${connection}", { field: "accessToken" })`;
}

/** One GitHub connection's repositories, listed through the project's egress with the connection's
 *  token as its placeholder. A pick links the config repo to one over the same placeholder, so the
 *  origin never holds the token. */
function GithubRepositories({
  projectId,
  connection,
  account,
  disabled,
  onPick,
}: {
  projectId: string;
  connection: string;
  account: string;
  disabled: boolean;
  onPick: (url: string) => Promise<void>;
}) {
  const { api } = shell.useRouteContext();
  const [listed, setListed] = useState<{ names: string[] } | { error: string }>();
  useEffect(() => {
    let disposed = false;
    const list = async () => {
      const response = await api.projects.get(projectId).fetch(
        new Request("https://api.github.com/installation/repositories?per_page=100", {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${githubTokenPlaceholder(connection)}`,
            // GitHub refuses a request without one; where the browser drops it (Chromium), the
            // egress sets its own
            "user-agent": "iterate-dash",
          },
        }),
      );
      if (!response.ok)
        throw new Error(`GitHub answered ${response.status}: ${await response.text()}`);
      return InstallationRepositories.parse(await response.json()).repositories.map(
        (repository) => repository.full_name,
      );
    };
    list().then(
      (names) => !disposed && setListed({ names }),
      (caught: unknown) =>
        !disposed &&
        setListed({ error: caught instanceof Error ? caught.message : String(caught) }),
    );
    return () => {
      disposed = true;
    };
  }, [api, projectId, connection]);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{account} on GitHub</span>
      {!listed ? (
        <p className="text-sm text-muted-foreground">Loading repositories…</p>
      ) : "error" in listed ? (
        <p role="alert" data-type="error" className="text-sm text-destructive">
          {listed.error}
        </p>
      ) : listed.names.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The app is installed on none of {account}&apos;s repositories.
        </p>
      ) : (
        <ul className="flex flex-col divide-y border-y" aria-label={`${account}'s repositories`}>
          {listed.names.map((name) => (
            <li key={name} className="flex items-center justify-between gap-2 py-2">
              <span className="font-mono text-sm">{name}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-label={`Link ${name}`}
                onClick={() =>
                  void onPick(
                    `https://x-access-token:${githubTokenPlaceholder(connection)}@github.com/${name}.git`,
                  )
                }
              >
                Link
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Its organization's owner deletes the project: the verb answers once its row is gone, and the
 *  organization's live record drops it from the list; its contexts and storage go after, on the
 *  project's own deletion saga. */
function DeleteProject({ project }: { project: { id: string; slug: string } }) {
  const { api } = shell.useRouteContext();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setError(null);
    setDeleting(true);
    try {
      await api.projects.delete(project.id);
      reloadOrganizationTree(); // the listed tree's; the live one follows by itself
      await navigate({ to: "/projects", replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Delete project</CardTitle>
        <CardDescription>
          Deletes the project, its site, custom hostnames, repositories, files and every agent and
          context in it. There is no undo.
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex-col items-start gap-3">
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" />} disabled={deleting}>
            {deleting ? <Spinner data-icon="inline-start" /> : null}
            Delete project
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {project.slug}?</AlertDialogTitle>
              <AlertDialogDescription>
                The project and everything in it go. There is no undo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {error ? (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardFooter>
    </Card>
  );
}

/** The creation checklist: the request is in (the directory row and `project/create-requested` —
 *  this page exists because it is) and the certificate is what the project processor owes; the live
 *  state swaps this out the moment it lands. */
function ProjectCreationProgress({ configRepoSeeded }: { configRepoSeeded: boolean }) {
  const steps = [
    { key: "registered", label: "Registering project", done: true },
    { key: "repo", label: "Seeding the config repository", done: configRepoSeeded },
    { key: "created", label: "Publishing the homepage", done: false },
  ];
  return (
    <section className="rounded-lg border bg-card p-6" data-testid="project-creation-progress">
      <h2 className="text-lg font-semibold">Creating your project</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Setting everything up — this page updates live as each step lands.
      </p>
      <ol className="mt-5 space-y-3">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex items-center gap-3 text-sm"
            data-testid={`creation-step-${step.key}`}
            data-done={step.done ? "true" : undefined}
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border",
                step.done
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              {step.done ? (
                <CheckIcon aria-hidden="true" className="size-4" />
              ) : (
                <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
              )}
            </span>
            <span className={step.done ? "text-foreground" : "text-muted-foreground"}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The project's root context as the page holds it: `api.projects.get(id)`, a capnweb stub. */
type ProjectContext = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;

/** The failure the project processor reported: the state keeps the OFFSET of `project/create-failed`
 *  on `/`, the event itself the words — read here, one row. */
function ProjectCreationFailed({ context, offset }: { context: ProjectContext; offset: number }) {
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    // `readEvents(after, limit)` answers the rows past `after`: the failure's own, first
    context
      .readEvents(offset - 1, 1)
      .then((page) => {
        if (disposed) return;
        const read = z.object({ error: z.string() }).safeParse(page.events[0]?.payload);
        setError(read.data?.error ?? "The failure's event could not be read.");
      })
      .catch(
        (caught: unknown) =>
          !disposed && setError(caught instanceof Error ? caught.message : String(caught)),
      );
    return () => {
      disposed = true;
    };
  }, [context, offset]);
  return (
    <section
      className="rounded-lg border border-destructive/40 bg-card p-6"
      data-testid="project-creation-failed"
    >
      <div className="flex items-center gap-2 text-destructive">
        <CircleXIcon aria-hidden="true" className="size-5" />
        <h2 className="text-lg font-semibold">Project creation failed</h2>
      </div>
      <p data-type="error" className="mt-3 text-sm text-muted-foreground">
        {error || "Reading what went wrong…"}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Try again — creating the project once more from the projects page is a new attempt; the
        project's log keeps the whole trail.
      </p>
    </section>
  );
}
