import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useMemo } from "react";
import { DocEditor } from "../../components/doc-editor.tsx";
import { DocSession } from "../../editor/doc-session.ts";
import { authorOf } from "../../lib/author.ts";
import { DOCS_REPO } from "../../lib/docs-repo.ts";

/** One doc: `/projects/<slug>/<path in /repos/docs>`, read at the repo's tip. */
export const Route = createFileRoute("/_auth/projects/$slug/$")({
  loader: async ({ context, params }) => {
    const path = params._splat || "";
    using itx = context.api.projects.get(context.project.id);
    using repo = itx.repos.get(DOCS_REPO);
    const tip = await repo.tip();
    // pinned to that tip: the autosave's first commit names it as its parent
    const text = tip ? await repo.readFile(path, { commitOid: tip }) : null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an empty doc is "" and a real doc; a missing one is null
    if (!tip || text === null) throw notFound();
    return { path, tip, text };
  },
  component: DocPage,
});

function DocPage() {
  const data = Route.useLoaderData();
  const { api, project, info } = Route.useRouteContext();
  const { slug } = Route.useParams();
  // one session per load: a new tip or another doc is a new editor
  const session = useMemo(
    () =>
      new DocSession({
        path: data.path,
        oid: data.tip,
        text: data.text,
        author: authorOf(info.principal),
        withRepo: async (work) => {
          using itx = await api.projects.get(project.id);
          using repo = itx.repos.get(DOCS_REPO);
          return await work(repo);
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
