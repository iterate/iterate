import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import type { IterateContextApi } from "iterate/api";
import { ensureDoc } from "@iterate-com/docs/install";
import { pkgPrNewVersion, publishedCommit } from "@iterate-com/shared/pkg-pr-new";
import { DocEditor } from "../../components/doc-editor.tsx";
import { DocSession } from "../../editor/doc-session.ts";
import { DOCS_REPO } from "../../lib/docs-repo.ts";

/** The @iterate-com/docs build a doc's processors run: this app's own commit's, else main's now
 *  (`publishedCommit`), resolved in the app's Worker because a page cannot read pkg.pr.new's commit
 *  header. */
const publishedDocs = createServerFn().handler(async () =>
  pkgPrNewVersion(
    "@iterate-com/docs",
    await publishedCommit("@iterate-com/docs", import.meta.env.VITE_SOURCE_COMMIT),
  ),
);

/** One doc: `/projects/<slug>/<path in /repos/docs>`, read at the repo's tip for the first paint;
 *  the editor goes live on the doc's processor (doc-session.ts). */
export const Route = createFileRoute("/_auth/projects/$slug/$")({
  loader: async ({ context, params }) => {
    const path = params._splat || "";
    using itx = context.api.projects.get(context.project.id);
    using repo = itx.repos.get(DOCS_REPO);
    const tip = await repo.tip();
    const text = tip ? await repo.readFile(path, { commitOid: tip }) : null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty doc is "" and a real doc; a missing one is null
    if (!tip || text === null) throw notFound();
    return { path, text };
  },
  component: DocPage,
});

function DocPage() {
  const data = Route.useLoaderData();
  const { api, project, info } = Route.useRouteContext();
  const { slug } = Route.useParams();
  // one session per load: another doc is a new editor
  const session = useMemo(
    () =>
      new DocSession({
        path: data.path,
        text: data.text,
        user: { name: info.principal.email || info.principal.actor },
        open: async () => {
          const itx = await api.projects.get(project.id);
          try {
            // The SDK models the public API as promises; capnweb's stub has the same runtime
            // methods, and disposes
            const context = await ensureDoc(
              itx as unknown as IterateContextApi,
              data.path,
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
    [data, api, project.id, info.principal],
  );
  return (
    <DocEditor
      key={data.path}
      session={session}
      path={data.path}
      back={
        <Link to="/projects/$slug" params={{ slug }} className="hover:text-foreground">
          All docs
        </Link>
      }
    />
  );
}
