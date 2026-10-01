import { useMutation } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import type { IterateContextApi } from "iterate/api";
import { docContextPath } from "@iterate-com/docs/frames";
import { docsModule, ensureDoc, installDocs } from "@iterate-com/docs/install";
import { pinPkgPrNewVersion, pkgPrNewVersion } from "iterate/pkg-pr-new";
import { startAppConfigOf } from "@iterate-com/shared/start-app-config";
import { Button } from "@iterate-com/ui/components/ui/button";
import { Spinner } from "@iterate-com/ui/components/ui/spinner";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@iterate-com/ui/components/ui/empty";
import { StreamLink } from "@iterate-com/ui/components/stream-link";
import { DocEditor } from "../../components/doc-editor.tsx";
import { DocSession } from "../../editor/doc-session.ts";
import { repoPath } from "../../lib/docs-repo.ts";
import { fileKind } from "../../lib/file-kind.ts";

/** The @iterate-com/docs build this deployment installs in a project (`APP_CONFIG pkgPrNewRef`:
 *  main's newest, pinned at the commit pkg.pr.new serves for it now, or a per-commit deployment's
 *  own). Asked in the app's Worker: a page cannot read pkg.pr.new's headers. */
const docsBuild = createServerFn({ method: "GET" }).handler(async () => {
  const { env } = await import("cloudflare:workers");
  const ref = startAppConfigOf(env).pkgPrNewRef;
  return pinPkgPrNewVersion("@iterate-com/docs", pkgPrNewVersion("@iterate-com/docs", ref));
});

/** One doc: `/projects/<slug>/<repo name>/<path in the repo>`, read at the repo's tip for the
 *  first paint; the editor goes live on the doc's processor (doc-session.ts), which runs the
 *  @iterate-com/docs build the project's config installs (`docs.ts`, @iterate-com/docs/install). */
export const Route = createFileRoute("/_auth/projects/$slug/$repo/$")({
  loader: async ({ context, params }) => {
    const path = params._splat || "";
    const kind = fileKind(path);
    // a binary file isn't read: Docs edits text
    if (kind === "binary") return { repo: params.repo, path, kind, text: "", installed: true };
    using itx = context.api.projects.get(context.project.id);
    using repo = itx.repos.get(repoPath(params.repo));
    const tip = await repo.tip();
    const text = tip ? await repo.readFile(path, { commitOid: tip }) : null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty doc is "" and a real doc; a missing one is null
    if (!tip || text === null) throw notFound();
    // the processors' code is the project's own, from its config
    using config = itx.repos.get("/repos/config");
    const installed = Boolean(await config.readFile(docsModule.path));
    return { repo: params.repo, path, kind, text, installed };
  },
  component: DocPage,
});

const root = getRouteApi("__root__");

function DocPage() {
  const data = Route.useLoaderData();
  const { dashOrigin } = root.useLoaderData();
  const { api, project, info } = Route.useRouteContext();
  const { slug, repo } = Route.useParams();
  const { repo: docRepo, path, text, kind } = data;
  const userName = info.principal.email || info.principal.actor;
  // One session per doc and person, keyed on values: a new session is a new editor and a new tab
  // on the doc, so a context object or loader result that's only a new copy mustn't make one.
  const session = useMemo(
    () =>
      new DocSession({
        path,
        // a binary file never mounts an editor (below)
        kind: kind === "binary" ? "code" : kind,
        text,
        user: { name: userName },
        open: async () => {
          const itx = await api.projects.get(project.id);
          try {
            // The SDK models the public API as promises; capnweb's stub has the same runtime
            // methods, and disposes
            const context = await ensureDoc(itx as unknown as IterateContextApi, {
              repo: repoPath(docRepo),
              path,
            });
            return {
              context,
              dispose: () => {
                // the context capnweb hands back is a stub, which disposes, though the
                // IterateContextApi type `cd` returns doesn't say so
                (context as unknown as Disposable)[Symbol.dispose]();
                itx[Symbol.dispose]();
              },
            };
          } catch (error) {
            itx[Symbol.dispose]();
            throw error;
          }
        },
      }),
    [docRepo, path, kind, text, userName, api, project.id],
  );
  if (kind === "binary") return <Binary path={path} />;
  if (!data.installed) return <NotInstalled project={project.id} />;
  return (
    <DocEditor
      key={`${docRepo}/${path}`}
      session={session}
      path={path}
      back={
        <Link to="/projects/$slug/$repo" params={{ slug, repo }} className="hover:text-foreground">
          {repo}
        </Link>
      }
      stream={
        <StreamLink
          dashOrigin={dashOrigin}
          platformOrigin={info.platformOrigin}
          project={slug}
          path={docContextPath({ repo: repoPath(docRepo), path })}
        />
      }
    />
  );
}

/** A project whose config doesn't install Docs, whose processors have no code to run yet: one
 *  click installs this deployment's build (`installDocs`), and the doc opens once the project runs
 *  it. */
function NotInstalled({ project }: { project: string }) {
  const { api } = Route.useRouteContext();
  const router = useRouter();
  const install = useMutation({
    mutationFn: async () => {
      const version = await docsBuild();
      using itx = await api.projects.get(project);
      await installDocs(itx, version);
      // the button stays "Installing…" until the page has the doc, so it can't commit twice
      await router.invalidate({ sync: true });
    },
  });
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Docs isn&apos;t installed in this project yet</EmptyTitle>
        <EmptyDescription>
          Installing it adds a <code>{docsModule.path}</code> and <code>@iterate-com/docs</code> to
          the project&apos;s config repo, as agents are installed.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button disabled={install.isPending} onClick={() => install.mutate()}>
          {install.isPending ? (
            <>
              <Spinner />
              Installing…
            </>
          ) : (
            "Install Docs in this project"
          )}
        </Button>
        {install.error ? <p className="text-sm text-destructive">{install.error.message}</p> : null}
      </EmptyContent>
    </Empty>
  );
}

/** A file Docs can't open: it isn't text. */
function Binary({ path }: { path: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{path.split("/").at(-1)} isn&apos;t text</EmptyTitle>
        <EmptyDescription>Docs opens text files: markdown, html and code.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
