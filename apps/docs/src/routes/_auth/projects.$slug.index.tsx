import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { useDocList } from "../../lib/doc-list.ts";
import { authorOf } from "../../lib/author.ts";
import { DOCS_REPO, newDocHeading, newDocPath } from "../../lib/docs-repo.ts";

/** Every doc in the project's docs repo (the page's live list, which also makes the repo on a
 *  project's first visit), and a box to start one; `folder/name` makes it in a folder. */
export const Route = createFileRoute("/_auth/projects/$slug/")({
  component: DocListPage,
});

function DocListPage() {
  const { list, docs } = useDocList();
  const { api, project, info } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: async (title: string) => {
      const path = newDocPath(title);
      if (!path) throw new Error("A title needs a letter or a digit in it.");
      using itx = await api.projects.get(project.id);
      // made already when the list has loaded, but the box can be quicker
      await itx.repos.create(DOCS_REPO);
      using repo = itx.repos.get(DOCS_REPO);
      // the repo as it is now, not as the page loaded it: someone may have made this doc since
      const { commitOid, paths } = await repo.listFiles();
      if (!paths.includes(path))
        await repo.commitFiles({
          message: `docs: new ${path}`,
          changes: [{ path, content: `# ${newDocHeading(title)}\n` }],
          parent: commitOid,
          author: authorOf(info.principal),
        });
      return path;
    },
    // returned, so the button stays pending until the doc's page has loaded
    onSuccess: (path) => {
      list.reload();
      return navigate({ to: "/projects/$slug/$", params: { slug, _splat: path } });
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(String(new FormData(event.currentTarget).get("title")));
  }
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <form onSubmit={submit} className="flex gap-2">
        <Input
          name="title"
          aria-label="New doc title"
          placeholder="New doc title, or folder/title"
          // "New doc" in the sidebar lands here to type a title
          autoFocus
          required
        />
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "New doc"}
        </Button>
      </form>
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      ) : null}
      {docs.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading docs…</p>
      ) : docs.kind === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't list the docs: {docs.message}
        </p>
      ) : docs.paths.length > 0 ? (
        <ul aria-label="Docs" className="flex flex-col divide-y rounded-lg border">
          {docs.paths.map((path) => (
            <li key={path}>
              <Link
                to="/projects/$slug/$"
                params={{ slug, _splat: path }}
                className="block px-4 py-2.5 font-mono text-sm hover:bg-muted"
              >
                {path}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No docs yet.</p>
      )}
    </main>
  );
}
