import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { toast } from "@iterate-com/ui/components/sonner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { InfoRow } from "~/components/info-row.tsx";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { StreamPage } from "~/components/stream-page.tsx";
import { breadcrumbLoaderData, streamBreadcrumb } from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import type { RepoProcessorState } from "~/types.ts";
import { useItx, useItxQuery, useItxState } from "~/itx/itx-react.tsx";

const CommitFileForm = z.object({
  path: z.string().trim().min(1, "File path is required"),
  content: z.string(),
  message: z.string().trim().min(1, "Commit message is required"),
});

const DEFAULT_COMMIT_FILE_FORM_VALUES = {
  path: "",
  content: "",
  message: "",
};

export const Route = createFileRoute("/_app/projects/$projectSlug/repos/$")({
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, repoPathFromSplat(params._splat)),
    }),
  component: ProjectRepoDetailPage,
});

function ProjectRepoDetailPage() {
  return (
    <ItxBoundary>
      <ProjectRepoDetailContent />
    </ItxBoundary>
  );
}

function ProjectRepoDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const repoPath = repoPathFromSplat(params._splat);
  const itx = useItx();
  // TODO: the old repo surface (readTree/readFile/git log,
  // clone token + command blocks) has no itx equivalent yet. The page
  // shows the repo processor's reduced state (live — commits and bootstrap
  // progress push in) plus whoami, and offers a minimal "commit file" form
  // via `repo.commitFiles`.
  const repoProcessor = useItxState<RepoProcessorState>(
    (itx, setState) => itx.repos.get(repoPath).processor.onStateChange(setState),
    [repoPath],
  );
  const whoami = useItxQuery({
    key: ["repo-whoami", project.slug, repoPath],
    query: (itx) => itx.repos.get(repoPath).whoami(),
  });
  const commitFile = useMutation({
    mutationFn: async (input: { path: string; content: string; message: string }) => {
      return await itx.repos.get(repoPath).commitFiles({
        message: input.message,
        changes: [{ path: input.path, content: input.content }],
      });
    },
    onSuccess: (result) => {
      form.reset();
      toast.success(
        result.noChanges
          ? "No changes to commit."
          : `Committed ${result.changedPaths.length} file(s) to ${result.branch} (${result.commitOid.slice(0, 7)}).`,
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not commit file.");
    },
  });
  const form = useForm({
    defaultValues: DEFAULT_COMMIT_FILE_FORM_VALUES,
    validators: {
      onChange: CommitFileForm,
      onSubmit: CommitFileForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = CommitFileForm.parse(value);
      await commitFile.mutateAsync(parsed);
    },
  });

  // While the processor's first push is in flight, the loading placeholder is
  // the PANEL — the stream view mounts immediately and warms in parallel.
  if (repoProcessor.state === undefined) {
    return (
      <StreamPage
        panel={
          <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
            Loading repo…
          </div>
        }
        projectId={project.id}
        streamPath={repoPath}
        emptyLabel="No events on this repo's stream yet."
      />
    );
  }
  const snapshot = { offset: repoProcessor.offset ?? 0, state: repoProcessor.state };

  const panel = (
    <>
      <div className="rounded-lg border bg-card">
        <InfoRow label="Whoami" value={whoami} />
        <InfoRow label="Created" value={snapshot.state.created ? "yes" : "no"} />
        <InfoRow label="Initialized" value={snapshot.state.initialized ? "yes" : "no"} />
        <InfoRow label="Default branch" value={snapshot.state.defaultBranch ?? "(none)"} />
        <InfoRow
          label="Remote"
          value={snapshot.state.remote ?? "(none)"}
          copyValue={snapshot.state.remote ?? undefined}
        />
        <InfoRow label="Artifact" value={snapshot.state.artifactName ?? "(none)"} />
        <InfoRow label="Processor offset" value={String(snapshot.offset)} />
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Commit a file</h2>
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
                    <FieldLabel htmlFor={field.name}>File path</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      placeholder="README.md"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="content">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Content</FieldLabel>
                  <Textarea
                    id={field.name}
                    name={field.name}
                    className="min-h-24 font-mono text-xs"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                  <FieldDescription>Full file content to write at the path.</FieldDescription>
                </Field>
              )}
            </form.Field>

            <form.Field name="message">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Commit message</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      placeholder="Update README"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
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
                disabled={!canSubmit || isSubmitting || commitFile.isPending}
              >
                {isSubmitting || commitFile.isPending ? "Committing..." : "Commit file"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>
    </>
  );

  return (
    <StreamPage
      panel={panel}
      projectId={project.id}
      streamPath={repoPath}
      emptyLabel="No events on this repo's stream yet."
    />
  );
}

function repoPathFromSplat(splat: string | undefined) {
  const suffix = splat?.replace(/^\/+/, "") ?? "";
  return `/repos/${suffix}`;
}
