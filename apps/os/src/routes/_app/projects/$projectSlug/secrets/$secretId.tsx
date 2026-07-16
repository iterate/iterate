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
import type { SecretDescription, SecretUpdateInput } from "../../../../../domains/secrets/types.ts";
import { InfoRow } from "~/components/info-row.tsx";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx, useLiveState } from "~/itx/itx-react.tsx";

const UpdateSecretForm = z.object({
  material: z.string(),
  egressUrls: z.string(),
});

export const Route = createFileRoute("/_app/projects/$projectSlug/secrets/$secretId")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context, params }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, `/secrets/${params.secretId}`),
    }),
  component: ProjectSecretDetailPage,
});

function ProjectSecretDetailPage() {
  return (
    <ItxBoundary>
      <ProjectSecretDetailContent />
    </ItxBoundary>
  );
}

function ProjectSecretDetailContent() {
  const params = Route.useParams();
  const { project } = Route.useLoaderData();
  const secretPath = `/secrets/${params.secretId}`;
  // Live secret processor state (the public description — material stays
  // write-only server-side): rotations and every egress-gated use push an
  // updated audit trail into this page while it's open.
  const { value: secret } = useLiveState(
    (itx) => itx.secrets.get(secretPath).liveState,
    (state) => state,
    [secretPath],
  );

  // While the processor's first push is in flight, the loading placeholder is
  // the PANEL — the stream view mounts immediately and warms in parallel.
  if (secret === undefined) {
    return (
      <ProjectStreamView
        panel={
          <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
            Loading secret…
          </div>
        }
        projectId={project.id}
        streamPath={secretPath}
        emptyLabel="No events on this secret's stream yet."
      />
    );
  }
  return <SecretDetail projectId={project.id} secret={secret} secretPath={secretPath} />;
}

function SecretDetail({
  projectId,
  secret,
  secretPath,
}: {
  projectId: string;
  secret: SecretDescription;
  secretPath: string;
}) {
  const itx = useItx();

  const updateSecret = useMutation({
    mutationFn: async (input: SecretUpdateInput) => {
      return await itx.secrets.get(secretPath).update(input);
    },
    onSuccess: () => {
      form.reset();
      toast.success("Secret updated");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  // TODO: the itx secret surface has no delete verb yet;
  // the delete button returns when it does.
  const form = useForm({
    defaultValues: {
      material: "",
      egressUrls: secret.egress.urls.join("\n"),
    },
    validators: {
      onChange: UpdateSecretForm,
      onSubmit: UpdateSecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = UpdateSecretForm.parse(value);
      const urls = parsed.egressUrls
        .split("\n")
        .map((url) => url.trim())
        .filter((url) => url !== "");
      await updateSecret.mutateAsync(
        parsed.material === ""
          ? { egress: { urls } }
          : { egress: { urls }, material: parsed.material },
      );
    },
  });

  const panel = (
    <>
      <div className="rounded-lg border bg-card">
        <InfoRow label="Material" value={secret.hasMaterial ? "Stored" : "Missing"} />
        <InfoRow
          label="Egress URLs"
          value={secret.egress.urls.length > 0 ? secret.egress.urls.join(", ") : "(none)"}
        />
        <InfoRow label="Used" value={`${secret.audit.usedCount} time(s)`} />
        <InfoRow label="Last used" value={secret.audit.lastUsedAt ?? "never"} />
        <InfoRow label="Last used by" value={secret.audit.lastUsedBy ?? "(unknown)"} />
        <InfoRow label="Last used URL" value={secret.audit.lastUsedUrl ?? "(unknown)"} />
      </div>

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
            <form.Field name="material">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>New value</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="password"
                      autoComplete="off"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>
                      Leave blank to clear the current material. Entering a value replaces it and
                      binds it to the egress origins below.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="egressUrls">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Egress URLs</FieldLabel>
                    <Textarea
                      id={field.name}
                      name={field.name}
                      className="min-h-24 font-mono text-xs"
                      placeholder={"https://api.example.com/*"}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={isInvalid}
                    />
                    <FieldDescription>
                      One URL pattern per line. Updating these origins without entering a
                      replacement value above clears the stored material.
                    </FieldDescription>
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
                disabled={!canSubmit || isSubmitting || updateSecret.isPending}
              >
                {isSubmitting || updateSecret.isPending ? "Updating..." : "Update Secret"}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>
    </>
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={projectId}
      streamPath={secretPath}
      emptyLabel="No events on this secret's stream yet."
    />
  );
}
