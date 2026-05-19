import { Copy, Play, Power, Terminal } from "lucide-react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { orpc } from "~/orpc/client.ts";

const ExecForm = z.object({
  command: z.string().trim().min(1, "Command is required"),
  cwd: z.string().trim().min(1, "Working directory is required"),
  timeout: z.number().int().positive().max(600_000),
});

export const Route = createFileRoute(
  "/_app/orgs/$organizationSlug/projects/$projectSlug/sandboxes/$sandboxSlug",
)({
  loader: async ({ context, params }) => {
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });
    await context.queryClient.ensureQueryData({
      ...orpc.project.sandboxes.get.queryOptions({
        input: {
          projectSlugOrId: project.id,
          sandboxSlug: params.sandboxSlug,
        },
      }),
      staleTime: 10_000,
    });

    return {
      breadcrumb: params.sandboxSlug,
      project,
    };
  },
  component: ProjectSandboxDetailPage,
});

function ProjectSandboxDetailPage() {
  const params = Route.useParams();
  const queryClient = useQueryClient();
  const { project } = Route.useLoaderData();
  const sandboxQueryOptions = orpc.project.sandboxes.get.queryOptions({
    input: {
      projectSlugOrId: project.id,
      sandboxSlug: params.sandboxSlug,
    },
  });
  const sandboxQuery = useQuery({
    ...sandboxQueryOptions,
    staleTime: 10_000,
  });
  const execSandbox = useMutation(
    orpc.project.sandboxes.exec.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: sandboxQueryOptions.queryKey });
        toast.success("Command finished");
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Command failed.");
      },
    }),
  );
  const wakeRuntime = useMutation(
    orpc.project.sandboxes.wake.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: sandboxQueryOptions.queryKey });
        toast.success("Sandbox runtime ready");
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Could not wake runtime.");
      },
    }),
  );
  const destroyRuntime = useMutation(
    orpc.project.sandboxes.destroyRuntime.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: sandboxQueryOptions.queryKey });
        toast.success("Sandbox runtime destroyed");
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Could not destroy runtime.");
      },
    }),
  );
  const form = useForm({
    defaultValues: {
      command: "pwd && ls -la /workspace && ls -la /workspace/iterate-config | head",
      cwd: "/workspace",
      timeout: 120_000,
    },
    validators: {
      onChange: ExecForm,
      onSubmit: ExecForm,
    },
    onSubmit: async ({ value }) => {
      const parsed = ExecForm.parse(value);
      await execSandbox.mutateAsync({
        projectSlugOrId: project.id,
        sandboxSlug: params.sandboxSlug,
        command: parsed.command,
        cwd: parsed.cwd,
        timeout: parsed.timeout,
      });
    },
  });
  const sandbox = sandboxQuery.data;

  if (!sandbox) {
    return (
      <section className="w-full p-4">
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          Loading Sandbox...
        </div>
      </section>
    );
  }

  return (
    <section className="flex w-full flex-col gap-4 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium">{sandbox.slug}</div>
          <div className="break-all font-mono text-xs text-muted-foreground">
            {sandbox.runtimeId}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={wakeRuntime.isPending || execSandbox.isPending}
            onClick={() =>
              wakeRuntime.mutate({
                projectSlugOrId: project.id,
                sandboxSlug: params.sandboxSlug,
              })
            }
          >
            <Play className="size-4" />
            {wakeRuntime.isPending ? "Waking..." : "Wake Runtime"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={destroyRuntime.isPending}
            onClick={() =>
              destroyRuntime.mutate({
                projectSlugOrId: project.id,
                sandboxSlug: params.sandboxSlug,
              })
            }
          >
            <Power className="size-4" />
            {destroyRuntime.isPending ? "Destroying..." : "Destroy Runtime"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <LifecycleStep label="Logical Sandbox" value="Durable Object" detail="Stored" active />
        <LifecycleStep
          label="Runtime"
          value="Cloudflare container"
          detail={wakeRuntime.isPending || execSandbox.isPending ? "Preparing" : "Lazy"}
          active={wakeRuntime.isPending || execSandbox.isPending}
        />
        <LifecycleStep label="Workspace" value="/workspace" detail="Mounted before exec" active />
      </div>

      <div className="rounded-lg border bg-card">
        <InfoRow label="Slug" value={sandbox.slug} />
        <InfoRow label="Runtime ID" value={sandbox.runtimeId} copyValue={sandbox.runtimeId} />
        <InfoRow
          label="Workspace"
          value={sandbox.workspacePath}
          copyValue={sandbox.workspacePath}
        />
        <InfoRow
          label="Iterate config"
          value={sandbox.iterateConfigPath}
          copyValue={sandbox.iterateConfigPath}
        />
      </div>

      <form
        className="flex flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="command">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Command</FieldLabel>
                  <Textarea
                    id={field.name}
                    name={field.name}
                    className="min-h-32 font-mono text-sm"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                  />
                  <FieldDescription>
                    Wakes the runtime, mounts /workspace, refreshes /workspace/iterate-config, then
                    runs through the Cloudflare Sandbox SDK.
                  </FieldDescription>
                  {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                </Field>
              );
            }}
          </form.Field>

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            <form.Field name="cwd">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Working directory</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
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

            <form.Field name="timeout">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Timeout ms</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="number"
                      min={1}
                      max={600_000}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(Number(event.target.value))}
                      aria-invalid={isInvalid}
                    />
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </div>
        </FieldGroup>

        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button
              className="self-start"
              type="submit"
              size="sm"
              disabled={!canSubmit || isSubmitting || execSandbox.isPending}
            >
              <Terminal className="size-4" />
              {isSubmitting || execSandbox.isPending ? "Running..." : "Run"}
            </Button>
          )}
        </form.Subscribe>
      </form>

      {execSandbox.data ? <ExecResultView result={execSandbox.data} /> : null}
    </section>
  );
}

function ExecResultView(input: {
  result: {
    exitCode: number;
    stderr: string;
    stdout: string;
    success: boolean;
  };
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="text-sm font-medium">
        Exit {input.result.exitCode} · {input.result.success ? "success" : "failed"}
      </div>
      <OutputBlock label="stdout" value={input.result.stdout} />
      <OutputBlock label="stderr" value={input.result.stderr} />
    </section>
  );
}

function OutputBlock(input: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
        <CopyButton value={input.value} />
      </div>
      <pre className="min-h-16 overflow-x-auto p-3 font-mono text-xs whitespace-pre-wrap">
        {input.value || "(empty)"}
      </pre>
    </div>
  );
}

function LifecycleStep(input: { active: boolean; detail: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-4">
      <div
        className={`mt-1 size-2 rounded-full ${
          input.active ? "bg-emerald-500" : "bg-muted-foreground"
        }`}
      />
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{input.label}</div>
        <div className="truncate text-sm font-medium">{input.value}</div>
        <div className="text-xs text-muted-foreground">{input.detail}</div>
      </div>
    </div>
  );
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
