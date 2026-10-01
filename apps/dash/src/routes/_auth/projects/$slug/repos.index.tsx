// /projects/<slug>/repos — the project's repos, each opening in the repo IDE (repos.$.tsx). Making
// an empty one is a SHEET (the dash's form shape), opened by "New repo" (`?new=1`) so it is a deep
// link: a name, the repo's path under `/repos/`, and the IDE opens on the new repo.
// The list is the route's loader; a create goes straight to the new repo's page.
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/ui/field";
import { Input } from "@iterate-com/ui/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/ui/sheet";
import { Spinner } from "@iterate-com/ui/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/ui/table";
import { ListPage } from "../../../../components/list-page.tsx";
import { dateOf } from "../../../../lib/dates.ts";

export const Route = createFileRoute("/_auth/projects/$slug/repos/")({
  // the sheet's state is the URL: `?new=1` opens it
  validateSearch: z.object({ new: z.literal(1).optional().catch(undefined) }),
  loader: async ({ context }) => ({
    repos: (await context.api.projects.get(context.project.id).repos.list()).toSorted((a, b) =>
      a.path.localeCompare(b.path),
    ),
  }),
  staticData: { page: "Repos" },
  head: ({ params }) => ({ meta: [{ title: `Repos · ${params.slug} · Dash` }] }),
  component: ProjectRepos,
});

/** A repo's name after `/repos/`: path segments of letters, digits, dots, dashes and underscores,
 *  none of them `.` or `..`. */
const REPO_NAME = /^(?!\.{1,2}(\/|$))[\w.-]+(\/(?!\.{1,2}(\/|$))[\w.-]+)*$/;

function ProjectRepos() {
  const { api, project } = Route.useRouteContext();
  const { repos } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [pending, setPending] = useState(false);
  return (
    <>
      <ListPage
        title="Repos"
        action={
          <Button onClick={() => void navigate({ search: { new: 1 } })}>
            <Plus data-icon="inline-start" />
            New repo
          </Button>
        }
        empty={repos.length ? undefined : "No repos yet: “New repo” makes the first."}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repo</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repos.map((repo) => (
              <TableRow key={repo.path}>
                <TableCell className="font-mono font-medium">
                  <Link
                    to="/projects/$slug/repos/$"
                    params={{ slug: project.slug, _splat: repo.path.replace(/^\/repos\//, "") }}
                    className="underline-offset-4 hover:underline"
                  >
                    {repo.path}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {dateOf(new Date(repo.createdAt).getTime())}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListPage>
      <Sheet
        open={search.new === 1}
        onOpenChange={(open) => {
          if (open || pending) return;
          void navigate({ search: {}, replace: true });
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={!pending}
          className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <NewRepoForm
            // mounted with the sheet: every opening starts empty
            pending={pending}
            onCreate={async (name) => {
              setPending(true);
              try {
                await api.projects.get(project.id).repos.create(`/repos/${name}`);
                await navigate({
                  to: "/projects/$slug/repos/$",
                  params: { slug: project.slug, _splat: name },
                });
              } finally {
                setPending(false);
              }
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The submit button, spinning from the moment the form is submitted: `useFormStatus` is the
 *  form action's own pending state, set in the same render as the submit. */
function CreateRepoButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? <Spinner data-icon="inline-start" /> : null}
      Create repo
    </Button>
  );
}

/** The sheet's body: the repo's name. A form action, so submitting needs no handler of its own. */
function NewRepoForm({
  pending,
  onCreate,
}: {
  pending: boolean;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim().replace(/^\/?(repos\/)?/, "");
  return (
    <form
      className="flex h-full flex-col"
      action={async () => {
        if (!REPO_NAME.test(trimmed)) {
          setError("Use letters, digits, dots, dashes and underscores; no `.` or `..` folders.");
          return;
        }
        setError(null);
        try {
          await onCreate(trimmed);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }}
    >
      <SheetHeader className="border-b">
        <SheetTitle>New repo</SheetTitle>
        <SheetDescription>An empty repo, ready for a first file in the repo IDE.</SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="repo-name">Name</FieldLabel>
          <div className="flex items-center gap-1">
            <span className="font-mono text-sm text-muted-foreground">/repos/</span>
            <Input
              id="repo-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="notes"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              required
            />
          </div>
          <FieldDescription>
            Folders are fine: `team/handbook` is `/repos/team/handbook`.
          </FieldDescription>
        </Field>
        {error ? (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <CreateRepoButton disabled={!trimmed} />
      </SheetFooter>
    </form>
  );
}
