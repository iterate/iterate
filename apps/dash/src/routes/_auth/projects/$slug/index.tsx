// /projects/<project>/ — the overview: the project, its role, its site — and, while the project's own
// creation runs, where it stands: the `project` facet's LIVE STATE on `/` (apps/os/src/project/),
// rendered as a creation checklist until `project/created` lands, or as the failure the
// processor reported. The frame the project's own pages fill in over time. Its organization's owner
// deletes the project here (`session.projects.delete`). The config repo's remote is linked, pulled
// and pushed here too (`itx.repos.get("/repos/config")`: `origin`, `setOrigin`, `pull`, `push`).
import { useCallback, useEffect, useRef, useState } from "react";
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
        <ConfigRepo key={project.id} project={project} githubConnections={githubConnections} />
      )}
      {org?.role === "owner" ? <DeleteProject project={project} /> : null}
    </div>
  );
}

/** What the config repo's section is doing, one action at a time. */
type ConfigRepoAction = "link" | "pull" | "push" | "replace" | "force-push" | "unlink";

/** The config repo's remote, git's `origin`, read again after every action, and its main pulled and
 *  pushed by hand. Every pull and push names the remote the page shows, so a link changed elsewhere
 *  since is never the one acted on. One sheet, one step at a time: `link` (`?configRepo=link`), and
 *  the choices a pull (`diverged`) or push (`behind`) that is not a fast-forward leaves, or replacing
 *  iterate's main (`replace`, the confirm). */
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
  const [step, setStep] = useState<"diverged" | "behind" | "replace" | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const configRepo = useCallback(
    () => api.projects.get(project.id).repos.get("/repos/config"),
    [api, project.id],
  );
  const readOrigin = useCallback(
    () =>
      configRepo()
        .origin()
        .then(
          (origin) => setRead({ origin }),
          (caught: unknown) => setError(messageOf(caught)),
        ),
    [configRepo],
  );
  useEffect(() => void readOrigin(), [readOrigin]);

  const remote = read?.origin ? describeOrigin(read.origin) : null;
  const sheet = step || (search.configRepo === "link" ? "link" : null);
  const closeSheet = async () => {
    setStep(null);
    setError(null);
    await navigate({ search: {}, replace: true });
  };
  const sync = async (verb: "pull" | "push", url: string, force?: true) => {
    const result = await configRepo()[verb]({ remote: url, force });
    setOutcome(
      result.status === "up-to-date"
        ? "Already up to date"
        : `${verb === "pull" ? "Pulled" : "Pushed"} ${(result.commitOid || "").slice(0, 7)}`,
    );
  };
  /** Success closes the sheet. A pull or push that is not a fast-forward opens it on the choice
   *  instead: only an unforced one throws that, and every action but "push" pulls. */
  const run = async (action: ConfigRepoAction, work: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    setOutcome(null);
    try {
      await work();
      await closeSheet();
    } catch (caught) {
      if (errorCode(caught) === "NOT_FAST_FORWARD")
        setStep(action === "push" ? "behind" : "diverged");
      else setError(messageOf(caught));
    }
    await readOrigin();
    setBusy(null);
  };
  const link = (url: string) =>
    run("link", async () => {
      setRead(await configRepo().setOrigin(url));
      await sync("pull", url);
    });
  /** A button that runs one action: disabled while any runs, its spinner while it does. */
  const actionButton = (
    action: ConfigRepoAction,
    label: string,
    work: () => Promise<unknown>,
    variant: "outline" | "destructive" = "outline",
  ) => (
    <Button variant={variant} disabled={Boolean(busy)} onClick={() => void run(action, work)}>
      {busy === action ? <Spinner data-icon="inline-start" /> : null}
      {label}
    </Button>
  );
  const choice =
    step && remote
      ? {
          diverged: {
            title: `${remote.name}'s main and iterate's have diverged`,
            description: `Each has commits the other lacks: keep ${remote.name}'s, or push iterate's over it.`,
          },
          behind: {
            title: `${remote.name} has commits iterate's main doesn't`,
            description: `Pushing anyway overwrites ${remote.name}'s main with iterate's, and those commits go.`,
          },
          replace: {
            title: `Replace iterate's main with ${remote.name}'s?`,
            description: `iterate's own commits since the two diverged are dropped from main, and the project republishes ${remote.name}'s version.`,
          },
        }[step]
      : null;

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
        <div className="flex flex-wrap gap-2">
          {remote ? (
            <>
              {actionButton("pull", "Pull now", () => sync("pull", remote.url))}
              {actionButton("push", "Push now", () => sync("push", remote.url))}
              <Button variant="outline" disabled={Boolean(busy)} onClick={() => setStep("replace")}>
                Replace with {remote.name}&apos;s
              </Button>
              {actionButton("unlink", "Unlink", () => configRepo().setOrigin(null))}
            </>
          ) : read ? (
            <Button onClick={() => void navigate({ search: { configRepo: "link" } })}>Link</Button>
          ) : null}
        </div>
      </div>
      {read || error ? null : <p className="text-sm text-muted-foreground">Loading…</p>}
      {read && !remote ? <p className="text-sm">Not linked</p> : null}
      {remote ? (
        <p className="text-sm">
          Linked to{" "}
          <a href={remote.href} target="_blank" rel="noreferrer" className="font-mono underline">
            {remote.label}
          </a>
        </p>
      ) : null}
      {outcome ? (
        <p role="status" className="text-sm text-muted-foreground">
          {outcome}
        </p>
      ) : null}
      {sheet ? null : <Failure error={error} />}
      <Sheet open={Boolean(sheet)} onOpenChange={(open) => !open && !busy && void closeSheet()}>
        <SheetContent
          side="right"
          showCloseButton={!busy}
          initialFocus={sheet === "link" ? firstField : undefined}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <form
            className="flex h-full flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void link(String(new FormData(event.currentTarget).get("url")).trim());
            }}
          >
            <SheetHeader className="border-b">
              <SheetTitle>{choice ? choice.title : "Link the config repo"}</SheetTitle>
              <SheetDescription>
                {choice
                  ? `${choice.description} Cancel keeps the link and moves nothing.`
                  : "iterate keeps the remote as the repo's origin and pulls its main."}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="flex-1 p-4">
              {sheet === "link" ? (
                <>
                  {githubConnections.map((row) => (
                    <GithubRepositories
                      key={row.connection}
                      projectId={project.id}
                      connection={row.connection}
                      account={row.account}
                      disabled={Boolean(busy)}
                      onPick={link}
                    />
                  ))}
                  <Field>
                    <FieldLabel htmlFor="config-repo-url">Git URL</FieldLabel>
                    <Input
                      id="config-repo-url"
                      name="url"
                      ref={firstField}
                      type="url"
                      required
                      pattern="https://[^@]+"
                      title="An https:// URL with no credentials in it"
                      placeholder="https://github.com/acme/site.git"
                      className="font-mono"
                    />
                    <FieldDescription>
                      Any public git remote over https.{" "}
                      {githubConnections.length > 0 ? null : (
                        <>
                          Connect GitHub on{" "}
                          <Link to="/projects/$slug/integrations" params={{ slug: project.slug }}>
                            Integrations
                          </Link>{" "}
                          to pick a private repository.
                        </>
                      )}
                    </FieldDescription>
                  </Field>
                </>
              ) : null}
              {choice && remote ? (
                <div className="flex flex-col items-start gap-3">
                  {step === "diverged" ? (
                    <Button
                      variant="destructive"
                      disabled={Boolean(busy)}
                      onClick={() => setStep("replace")}
                    >
                      Replace with {remote.name}&apos;s main
                    </Button>
                  ) : null}
                  {step === "replace"
                    ? actionButton(
                        "replace",
                        "Replace",
                        () => sync("pull", remote.url, true),
                        "destructive",
                      )
                    : actionButton(
                        "force-push",
                        step === "diverged"
                          ? `Push iterate's to ${remote.name}`
                          : "Push iterate's anyway",
                        () => sync("push", remote.url, true),
                        "destructive",
                      )}
                </div>
              ) : null}
              <Failure error={error} />
            </FieldGroup>
            <SheetFooter className="border-t sm:flex-row sm:justify-end">
              <SheetClose
                disabled={Boolean(busy)}
                render={<Button type="button" variant="outline" />}
              >
                Cancel
              </SheetClose>
              {sheet === "link" ? (
                <Button type="submit" disabled={Boolean(busy)}>
                  {busy === "link" ? <Spinner data-icon="inline-start" /> : null}
                  Link
                </Button>
              ) : null}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </section>
  );
}

/** An origin for the page: its URL as stored, the remote's name, and how it shows and links. A
 *  GitHub repository shows as `owner/repo`, any other remote as its URL. Either way without the
 *  userinfo, where a secret's placeholder sits (unencoded, it holds slashes, so the host starts after
 *  the last `@`). */
function describeOrigin(url: string) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)?.[0] ?? "";
  const rest = url.slice(scheme.length);
  const bare = scheme + rest.slice(rest.lastIndexOf("@") + 1);
  const parsed = URL.parse(bare);
  const github =
    parsed?.host === "github.com"
      ? /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname)?.[1]
      : null;
  return github
    ? { url, name: "GitHub", label: github, href: `https://github.com/${github}` }
    : { url, name: parsed?.host || "the remote", label: bare, href: bare };
}

/** An error's words for the page, with any secret placeholder (`getSecret(…)`) cut out. */
function messageOf(caught: unknown) {
  return (caught instanceof Error ? caught.message : String(caught)).replace(
    /getSecret\([^)]*\)?/g,
    "…",
  );
}

/** A failure's words, marked for the specs' ui-error-reporter. */
function Failure({ error }: { error?: string | null }) {
  return error ? (
    <p role="alert" data-type="error" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

/** GitHub's page of an installation's repositories, the one field read. */
const InstallationRepositories = z.object({
  repositories: z.array(z.object({ full_name: z.string() })),
});

/** One GitHub connection's repositories (the first thousand), listed through the project's egress
 *  with the connection's token as its placeholder. A pick links over the same placeholder, so the
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
  const [listed, setListed] = useState<{ names: string[]; error?: string }>();
  const token = `getSecret("/secrets/github-${connection}", { field: "accessToken" })`;
  useEffect(() => {
    const list = async () => {
      const names: string[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const url = `https://api.github.com/installation/repositories?per_page=100&page=${page}`;
        const response = await api.projects.get(projectId).fetch(
          new Request(url, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${token}`,
              // GitHub refuses a request without one; where the browser drops it (Chromium), the
              // egress sets its own
              "user-agent": "iterate-dash",
            },
          }),
        );
        // the status alone: a failed egress's body can quote the placeholder
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Couldn't list ${account}'s repositories (HTTP ${response.status})`);
        }
        const { repositories } = InstallationRepositories.parse(await response.json());
        names.push(...repositories.map((repository) => repository.full_name));
        if (repositories.length < 100) break;
      }
      return names;
    };
    list().then(
      (names) => setListed({ names }),
      (caught: unknown) => setListed({ names: [], error: messageOf(caught) }),
    );
  }, [api, projectId, token, account]);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">
        {account} on GitHub{listed ? "" : ": loading repositories…"}
      </span>
      <Failure error={listed?.error} />
      <ul className="flex flex-col divide-y" aria-label={`${account}'s repositories`}>
        {listed?.names.map((name) => (
          <li key={name} className="flex items-center justify-between gap-2 py-2">
            <span className="font-mono text-sm">{name}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label={`Link ${name}`}
              onClick={() => void onPick(`https://x-access-token:${token}@github.com/${name}.git`)}
            >
              Link
            </Button>
          </li>
        ))}
      </ul>
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
