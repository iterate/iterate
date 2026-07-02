import { Copy } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { useItx, useItxQuery } from "~/itx/itx-react.tsx";

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
  ssr: false,
  loader: ({ context, params }) => ({
    breadcrumb: repoPathFromSplat(params._splat),
    project: context.project,
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
  const queryClient = useQueryClient();
  const repoKey = ["repo", project.slug, repoPath];
  // TODO(itx-v4 cutover): the old repo surface (readTree/readFile/git log,
  // clone token + command blocks) has no itx equivalent yet. The page
  // shows the repo processor's reduced state plus whoami, and offers a minimal
  // "commit file" form via `repo.commitFiles`.
  const repo = useItxQuery({
    key: repoKey,
    query: async (itx) => {
      const handle = itx.repos.get(repoPath);
      const [whoami, snapshot] = await Promise.all([handle.whoami(), handle.processor.snapshot()]);
      return { whoami, snapshot };
    },
  });
  const commitFile = useMutation({
    mutationFn: async (input: { path: string; content: string; message: string }) => {
      return await itx.repos.get(repoPath).commitFiles({
        message: input.message,
        changes: [{ path: input.path, content: input.content }],
      });
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["itx", ...repoKey] });
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

  const { snapshot, whoami } = repo;

  return (
    <section className="w-full space-y-4 p-4">
      <div className="rounded-lg border bg-card">
        <InfoRow label="Path" value={repoPath} />
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
    </section>
  );
}

function repoPathFromSplat(splat: string | undefined) {
  const suffix = splat?.replace(/^\/+/, "") ?? "";
  return `/repos/${suffix}`;
}

function InfoRow(input: { copyValue?: string; label: string; value: string }) {
  return (
    <div className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center">
      <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
      <code className="min-w-0 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {input.value}
      </code>
      {input.copyValue ? <CopyButton value={input.copyValue} /> : <div />}
    </div>
  );
}

function CopyButton(input: { value: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-8 w-8 shrink-0"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(input.value).then(
          () => toast.success("Copied"),
          () => toast.error("Could not copy"),
        );
      }}
    >
      <Copy className="h-4 w-4" />
    </Button>
  );
}
