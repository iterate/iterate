import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { RepoArtifactNameCodec } from "~/domains/repos/utils.ts";
import { buildArtifactViewerUrl } from "~/lib/artifact-viewer-url.ts";
import { formatRelativeTime } from "~/lib/format-relative-time.ts";
import { getPublicRouteConfig } from "~/lib/public-route-config.ts";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

const CreateRepoForm = z.object({
  path: z
    .string()
    .trim()
    .min(1, "Repo path is required")
    .regex(/^\/repos\/.+$/, 'Use a repo path like "/repos/project".'),
});

const DEFAULT_CREATE_REPO_FORM_VALUES = {
  path: "/repos/",
};

type SortKey = "path" | "createdAt";
type SortDirection = "asc" | "desc";

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/")({
  ssr: false,
  loader: async ({ context }) => {
    const { project } = context;
    const routeConfig = await getPublicRouteConfig();

    return {
      breadcrumb: "/repos",
      project,
      routeConfig,
    };
  },
  component: ProjectReposIndexPage,
});

function ProjectReposIndexPage() {
  return (
    <ItxBoundary>
      <ProjectReposIndexContent />
    </ItxBoundary>
  );
}

function ProjectReposIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project, routeConfig } = Route.useLoaderData();
  const itx = useItx();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "createdAt",
    direction: "desc",
  });
  const reposKey = ["repos", project.slug];
  const reposList = useItxQuery({ key: reposKey, query: (itx) => itx.repos.list() });
  const createRepo = useMutation({
    mutationFn: async (input: { path: string }) => {
      await itx.repos.create({ path: input.path });
      return input.path;
    },
    onSuccess: async (path) => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...reposKey] });
      form.reset();
      void navigate({
        to: "/projects/$projectSlug/repos/$",
        params: {
          projectSlug: params.projectSlug,
          _splat: repoPathToSplat(path),
        },
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not create Repo.");
    },
  });
  const form = useForm({
    defaultValues: DEFAULT_CREATE_REPO_FORM_VALUES,
    validators: {
      onChange: CreateRepoForm,
      onSubmit: CreateRepoForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = CreateRepoForm.parse(value);
      await createRepo.mutateAsync({ path: parsed.path });
    },
  });

  const repos = reposList;
  const visibleRepos = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return repos
      .filter((repo) => {
        if (!query) return true;
        return repo.path.toLowerCase().includes(query);
      })
      .toSorted((left, right) => {
        const direction = sort.direction === "asc" ? 1 : -1;
        return direction * compareRepoRows(left, right, sort.key);
      });
  }, [filter, repos, sort]);

  return (
    <section className="w-full space-y-4 p-4">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="path">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Path</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      placeholder="/repos/project"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>Project-local repo path.</FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>

          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button
                className="self-start"
                type="submit"
                size="sm"
                disabled={!canSubmit || isSubmitting || createRepo.isPending}
              >
                {isSubmitting || createRepo.isPending ? "Creating..." : "Create Repo"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>

      <div className="flex w-full flex-col gap-2 md:flex-row">
        <Input
          className="h-9 flex-1"
          placeholder="Filter repos..."
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="md:shrink-0"
          onClick={() => setFilter("")}
        >
          Reset
        </Button>
      </div>

      {repos.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No Repos</EmptyTitle>
            <EmptyDescription>
              Project Repos will appear here after they are created.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  active={sort.key === "path"}
                  direction={sort.direction}
                  label="Repo"
                  onClick={() => setSort(nextSort(sort, "path"))}
                />
                <SortableHead
                  active={sort.key === "createdAt"}
                  direction={sort.direction}
                  label="Created"
                  onClick={() => setSort(nextSort(sort, "createdAt"))}
                />
                <TableHead>Artifact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRepos.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    No Repos match.
                  </TableCell>
                </TableRow>
              ) : (
                visibleRepos.map((repo) => {
                  const artifactViewerUrl = buildArtifactViewerUrl({
                    appBaseUrl: routeConfig.baseUrl,
                    artifactName: RepoArtifactNameCodec.stringify({
                      projectId: project.id,
                      path: repo.path,
                    }),
                  });
                  const repoSplat = repoPathToSplat(repo.path);

                  return (
                    <TableRow key={repo.path}>
                      <TableCell className="min-w-[18rem] py-3">
                        <Link
                          className="block min-w-0 truncate rounded-sm text-sm font-medium hover:underline"
                          to="/projects/$projectSlug/repos/$"
                          params={{
                            projectSlug: params.projectSlug,
                            _splat: repoSplat,
                          }}
                        >
                          {repo.path}
                        </Link>
                      </TableCell>
                      <TableCell className="w-40 text-muted-foreground">
                        {formatRelativeTime(repo.createdAt)}
                      </TableCell>
                      <TableCell className="w-32">
                        <a
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                          href={artifactViewerUrl ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink className="size-4" />
                          Artifact
                        </a>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function SortableHead(input: {
  active: boolean;
  direction: SortDirection;
  label: string;
  onClick: () => void;
}) {
  return (
    <TableHead>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-8 px-2"
        onClick={input.onClick}
      >
        {input.label}
        <span className="text-[10px] text-muted-foreground">
          {input.active ? input.direction : "sort"}
        </span>
      </Button>
    </TableHead>
  );
}

function nextSort(current: { key: SortKey; direction: SortDirection }, key: SortKey) {
  if (current.key !== key) return { key, direction: "asc" as const };
  return { key, direction: current.direction === "asc" ? ("desc" as const) : ("asc" as const) };
}

function compareRepoRows(
  left: { path: string; createdAt: string },
  right: { path: string; createdAt: string },
  key: SortKey,
) {
  if (key === "path") return left.path.localeCompare(right.path);
  return new Date(left[key]).getTime() - new Date(right[key]).getTime();
}

function repoPathToSplat(path: string) {
  return path.startsWith("/repos/") ? path.slice("/repos/".length) : path;
}
