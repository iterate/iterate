import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { authorOf } from "../../lib/author.ts";
import { DOCS_REPO, docPaths, newDocPath } from "../../lib/docs-repo.ts";

/** Every doc in the project's docs repo, and a box to start one. The repo is made on first visit. */
export const Route = createFileRoute("/_auth/projects/$slug/")({
  loader: async ({ context }) => {
    // the project's root context, pipelined: the calls below ride it before it has resolved
    using itx = context.api.projects.get(context.project.id);
    await itx.repos.create(DOCS_REPO);
    using repo = itx.repos.get(DOCS_REPO);
    const { paths } = await repo.listFiles();
    return { docs: docPaths(paths) };
  },
  component: DocList,
});

function DocList() {
  const { docs } = Route.useLoaderData();
  const { api, project, info } = Route.useRouteContext();
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: async (title: string) => {
      const path = newDocPath(title);
      if (!path) throw new Error("A title needs a letter or a digit in it.");
      using itx = await api.projects.get(project.id);
      using repo = itx.repos.get(DOCS_REPO);
      // the repo as it is now, not as the page loaded it: someone may have made this doc since
      const { commitOid, paths } = await repo.listFiles();
      if (!paths.includes(path))
        await repo.commitFiles({
          message: `docs: new ${path}`,
          changes: [{ path, content: `# ${title.trim()}\n` }],
          parent: commitOid,
          author: authorOf(info.principal),
        });
      return path;
    },
    onSuccess: (path) => navigate({ to: "/projects/$slug/$", params: { slug, _splat: path } }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(String(new FormData(event.currentTarget).get("title")));
  }
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <form onSubmit={submit} className="flex gap-2">
        <Input name="title" aria-label="New doc title" placeholder="New doc title" required />
        <Button type="submit" disabled={create.isPending}>
          New doc
        </Button>
      </form>
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      ) : null}
      {docs.length > 0 ? (
        <ul aria-label="Docs" className="flex flex-col divide-y rounded-lg border">
          {docs.map((path) => (
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
