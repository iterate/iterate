import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@iterate-com/ui/components/sheet";
import { toast } from "@iterate-com/ui/components/sonner";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { ItxBoundary } from "~/components/itx-boundary.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.lazy.tsx";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import {
  breadcrumbLoaderData,
  streamBreadcrumb,
  streamPageStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { StreamViewSearch } from "~/lib/stream-view-search.ts";
import { useItx, useLiveState } from "~/itx/itx-react.tsx";

/** Secrets live at `/secrets/<name>`; the route param is the bare name. */
const secretPathFromName = (name: string) => `/secrets/${name}`;
const secretNameFromPath = (path: string) =>
  path.startsWith("/secrets/") ? path.slice("/secrets/".length) : path;

const SecretForm = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Secret name is required")
    .regex(/^[^/]+$/, "Secret names cannot contain slashes"),
  material: z.string().min(1, "Secret material is required"),
  egressUrls: z.string(),
});

const DEFAULT_SECRET_FORM_VALUES = {
  name: "",
  material: "",
  egressUrls: "",
};

/** One URL pattern per line, blanks dropped — the same shape the detail page's
 * update form speaks. */
const parseEgressUrls = (raw: string): string[] =>
  raw
    .split("\n")
    .map((url) => url.trim())
    .filter((url) => url !== "");

export const Route = createFileRoute("/_app/projects/$projectSlug/secrets/")({
  staticData: streamPageStaticData(),
  validateSearch: StreamViewSearch,
  ssr: false,
  loader: ({ context }) =>
    breadcrumbLoaderData({
      project: context.project,
      streamBreadcrumb: streamBreadcrumb(context.project, "/secrets"),
    }),
  component: ProjectSecretsIndexPage,
});

function ProjectSecretsIndexPage() {
  return (
    <ItxBoundary>
      <ProjectSecretsIndexContent />
    </ItxBoundary>
  );
}

function ProjectSecretsIndexContent() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const { project } = Route.useLoaderData();
  const itx = useItx();
  const [filter, setFilter] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  // The secrets list is a slice of the project processor's reduced state; the
  // processor pushes state changes, so a new secret appears here without any
  // invalidation.
  const projectState = useLiveState(
    (itx) => itx.liveState,
    (state) => state.reduced,
    [],
  ).value;
  const secretsList = projectState?.secrets;

  const createSecret = useMutation({
    mutationFn: async (input: { name: string; material: string; egressUrls: string[] }) => {
      // Material and egress land in ONE birth, so the secret is born already
      // pinned to its hosts — no window where it exists but cannot be used.
      await itx.secrets.get(secretPathFromName(input.name)).create({
        egress: { urls: input.egressUrls },
        material: input.material,
      });
      return input.name;
    },
    onSuccess: (name) => {
      form.reset();
      setSheetOpen(false);
      void navigate({
        to: "/projects/$projectSlug/secrets/$secretId",
        params: {
          projectSlug: params.projectSlug,
          secretId: name,
        },
        // Fresh view state on the new secret's page.
        search: {},
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });
  // TODO: the itx secret surface has no delete verb yet;
  // the per-row delete button returns when it does.
  const form = useForm({
    defaultValues: DEFAULT_SECRET_FORM_VALUES,
    validators: {
      onChange: SecretForm,
      onSubmit: SecretForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = SecretForm.parse(value);
      await createSecret.mutateAsync({
        name: parsed.name,
        material: parsed.material,
        egressUrls: parseEgressUrls(parsed.egressUrls),
      });
    },
  });

  const visibleSecrets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (secretsList ?? [])
      .filter((secret) => {
        if (!query) return true;
        return secret.path.toLowerCase().includes(query);
      })
      .toSorted((left, right) => left.path.localeCompare(right.path));
  }, [filter, secretsList]);

  const panel = (
    <>
      <div className="flex w-full flex-col gap-2 md:flex-row">
        <Input
          className="h-9 flex-1"
          placeholder="Filter secrets..."
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
        <Sheet
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
            if (!open) form.reset();
          }}
        >
          <SheetTrigger render={<Button type="button" size="sm" className="md:shrink-0" />}>
            <Plus className="h-4 w-4" />
            Add secret
          </SheetTrigger>
          <SheetContent side="right" className="overflow-y-auto">
            <form
              className="flex h-full flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void form.handleSubmit();
              }}
            >
              <SheetHeader>
                <SheetTitle>Add secret</SheetTitle>
                <SheetDescription>
                  Material is write-only: it can only ever leave toward the egress URLs you pin
                  here.
                </SheetDescription>
              </SheetHeader>
              <FieldGroup className="flex-1 space-y-4 p-4">
                <form.Field name="name">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          placeholder="openai"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                          aria-invalid={isInvalid}
                        />
                        <FieldDescription>
                          Stored at <code className="text-xs">/secrets/&lt;name&gt;</code>.
                        </FieldDescription>
                        {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                      </Field>
                    );
                  }}
                </form.Field>

                <form.Field name="material">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Value</FieldLabel>
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
                          Stored material is never returned by the API.
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
                          One URL pattern per line. The secret can only be sent to matching egress
                          URLs; you can also add these later on the secret&apos;s page.
                        </FieldDescription>
                        {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                      </Field>
                    );
                  }}
                </form.Field>
              </FieldGroup>

              <SheetFooter>
                <form.Subscribe
                  selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                  {([canSubmit, isSubmitting]) => (
                    <Button
                      type="submit"
                      disabled={!canSubmit || isSubmitting || createSecret.isPending}
                    >
                      {isSubmitting || createSecret.isPending ? "Saving..." : "Save Secret"}
                    </Button>
                  )}
                </form.Subscribe>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      </div>

      {secretsList === undefined ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground" data-spinner="true">
          Loading secrets…
        </div>
      ) : secretsList.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No Secrets</EmptyTitle>
            <EmptyDescription>
              Project Secrets will appear here after they are created.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-3">
          {visibleSecrets.length === 0 ? (
            <div className="rounded-lg border p-4 text-sm text-muted-foreground">
              No Secrets match.
            </div>
          ) : (
            visibleSecrets.map((secret) => (
              <div
                key={secret.path}
                className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    className="flex min-w-0 items-center gap-2 text-sm font-medium hover:underline"
                    to="/projects/$projectSlug/secrets/$secretId"
                    params={{
                      projectSlug: params.projectSlug,
                      secretId: secretNameFromPath(secret.path),
                    }}
                    search={{}}
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{secretNameFromPath(secret.path)}</span>
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {secret.path} · Created {formatTimeAgo(secret.createdAt)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );

  return (
    <ProjectStreamView
      panel={panel}
      projectId={project.id}
      streamPath="/secrets"
      emptyLabel="No events on the secrets catalogue stream yet."
    />
  );
}
