// /projects/<slug>/repos — the project's repos, each opening in the repo IDE
// (repos.$.tsx), and a form to make an empty one: the repo's path under `/repos/`.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useContextStub } from "iterate/react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { useRead } from "@iterate-com/ui/components/repo-ide/repo-client";
import { ListPage } from "../../../../components/list-page.tsx";
import { dateOf } from "../../../../lib/dates.ts";

const shell = getRouteApi("/_auth");
const projectRoute = getRouteApi("/_auth/projects/$slug");

export const Route = createFileRoute("/_auth/projects/$slug/repos/")({
  staticData: { page: "Repos" },
  head: ({ params }) => ({ meta: [{ title: `Repos · ${params.slug} · Dash` }] }),
  component: ProjectRepos,
});

/** The name after `/repos/` a repo may have: path segments of letters, digits, dots, dashes and
 *  underscores. */
const REPO_NAME = /^[\w.-]+(\/[\w.-]+)*$/;

function ProjectRepos() {
  const { api } = shell.useRouteContext();
  const { project } = projectRoute.useRouteContext();
  const navigate = useNavigate();
  const context = useContextStub(() => api.projects.get(project.id), [api, project.id]);
  const stub = context.stub;
  const repos = useRead(
    async () =>
      stub ? (await stub.repos.list()).toSorted((a, b) => a.path.localeCompare(b.path)) : [],
    [stub],
  );
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim().replace(/^\/?(repos\/)?/, "");
    if (!stub) return;
    if (!REPO_NAME.test(trimmed))
      return setError("Use letters, digits, dots, dashes and underscores.");
    setCreating(true);
    setError(null);
    try {
      await stub.repos.create(`/repos/${trimmed}`);
      await navigate({
        to: "/projects/$slug/repos/$",
        params: { slug: project.slug, _splat: trimmed },
        search: {},
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  const rows = repos.status === "loaded" ? repos.value : [];
  return (
    <ListPage
      title="Repos"
      action={
        <form className="flex items-center gap-2" onSubmit={(event) => void create(event)}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="new-repo"
            aria-label="New repo name"
            className="w-48 font-mono"
          />
          <Button type="submit" disabled={creating || !stub || name.trim() === ""}>
            {creating ? <Spinner /> : null}
            New repo
          </Button>
        </form>
      }
      empty={
        rows.length ? undefined : context.error || repos.status === "failed" ? (
          context.error || (repos.status === "failed" ? repos.message : "")
        ) : repos.status === "pending" ? (
          <span className="flex items-center gap-2">
            <Spinner /> Loading the repos…
          </span>
        ) : (
          "No repos yet: name one above."
        )
      }
    >
      {error ? (
        <p role="alert" data-type="error" className="p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Repo</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((repo) => {
            const tail = repo.path.replace(/^\/repos\//, "");
            return (
              <TableRow key={repo.path}>
                <TableCell className="font-mono font-medium">
                  <Link
                    to="/projects/$slug/repos/$"
                    params={{ slug: project.slug, _splat: tail }}
                    search={{}}
                    className="underline-offset-4 hover:underline"
                  >
                    {repo.path}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {dateOf(new Date(repo.createdAt).getTime())}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ListPage>
  );
}
