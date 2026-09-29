import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo } from "react";
import type { IterateContextApi } from "iterate/api";
import { docsModule, ensureDoc } from "@iterate-com/docs/install";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { DocEditor } from "../../components/doc-editor.tsx";
import { DocSession } from "../../editor/doc-session.ts";
import { repoPath } from "../../lib/docs-repo.ts";

/** One doc: `/projects/<slug>/<repo name>/<path in the repo>`, read at the repo's tip for the
 *  first paint; the editor goes live on the doc's processor (doc-session.ts), which runs the
 *  @iterate-com/docs build the project's config installs (`docs.ts`, @iterate-com/docs/install). */
export const Route = createFileRoute("/_auth/projects/$slug/$repo/$")({
  loader: async ({ context, params }) => {
    const path = params._splat || "";
    using itx = context.api.projects.get(context.project.id);
    using repo = itx.repos.get(repoPath(params.repo));
    const tip = await repo.tip();
    const text = tip ? await repo.readFile(path, { commitOid: tip }) : null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty doc is "" and a real doc; a missing one is null
    if (!tip || text === null) throw notFound();
    // the processors' code is the project's own, from its config
    using config = itx.repos.get("/repos/config");
    const installed = Boolean(await config.readFile(docsModule.path));
    return { repo: params.repo, path, text, installed };
  },
  component: DocPage,
});

function DocPage() {
  const data = Route.useLoaderData();
  const { api, project, info } = Route.useRouteContext();
  const { slug, repo } = Route.useParams();
  const { repo: docRepo, path, text } = data;
  const userName = info.principal.email || info.principal.actor;
  // One session per doc and person, keyed on values: a new session is a new editor and a new tab
  // on the doc, so a context object or loader result that's only a new copy mustn't make one.
  const session = useMemo(
    () =>
      new DocSession({
        path,
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
    [docRepo, path, text, userName, api, project.id],
  );
  if (!data.installed) return <NotInstalled />;
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
    />
  );
}

/** A project whose config doesn't install Docs: its processors have no code to run. */
function NotInstalled() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Docs is not installed in this project</EmptyTitle>
        <EmptyDescription>
          Its config repo installs it, as it does agents: a <code>{docsModule.path}</code> that says{" "}
          <code>{docsModule.content.trim()}</code>, and <code>@iterate-com/docs</code> in the root{" "}
          <code>package.json</code>&apos;s dependencies.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
