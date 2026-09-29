import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import type { IterateContextApi } from "iterate/api";
import { ensureDoc } from "@iterate-com/docs/install";
import { pkgPrNewVersion, publishedCommit } from "@iterate-com/shared/pkg-pr-new";
import { DocEditor } from "../../components/doc-editor.tsx";
import { DocSession } from "../../editor/doc-session.ts";
import { repoPath } from "../../lib/docs-repo.ts";

/** The @iterate-com/docs build a doc's processors run: this app's own commit's, else main's now
 *  (`publishedCommit`), resolved in the app's Worker because a page cannot read pkg.pr.new's commit
 *  header. */
const publishedDocs = createServerFn().handler(async () =>
  pkgPrNewVersion(
    "@iterate-com/docs",
    await publishedCommit("@iterate-com/docs", import.meta.env.VITE_SOURCE_COMMIT),
  ),
);

/** One doc: `/projects/<slug>/<repo name>/<path in the repo>`, read at the repo's tip for the
 *  first paint; the editor goes live on the doc's processor (doc-session.ts). */
export const Route = createFileRoute("/_auth/projects/$slug/$repo/$")({
  loader: async ({ context, params }) => {
    const path = params._splat || "";
    using itx = context.api.projects.get(context.project.id);
    using repo = itx.repos.get(repoPath(params.repo));
    const tip = await repo.tip();
    const text = tip ? await repo.readFile(path, { commitOid: tip }) : null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty doc is "" and a real doc; a missing one is null
    if (!tip || text === null) throw notFound();
    return { repo: params.repo, path, text };
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
            const context = await ensureDoc(
              itx as unknown as IterateContextApi,
              { repo: repoPath(docRepo), path },
              await publishedDocs(),
            );
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
