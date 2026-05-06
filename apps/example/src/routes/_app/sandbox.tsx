import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { toast } from "@iterate-com/ui/components/sonner";

type SandboxStatusResponse = {
  sandboxId: string;
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

type SandboxRunResponse = {
  sandboxId: string;
  command: string;
  durationMs: number;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_CODE = `const facts = {
  message: "hello from the Cloudflare sandbox",
  node: process.version,
  cwd: process.cwd(),
  random: Math.random(),
};

const response = await fetch("https://example.com");
facts.egressStatus = response.status;

console.log(JSON.stringify(facts, null, 2));
`;

const sandboxStatusQueryKey = ["sandbox", "status"] as const;

export const Route = createFileRoute("/_app/sandbox")({
  ssr: false,
  staticData: {
    breadcrumb: "Sandbox",
  },
  component: SandboxPage,
});

function SandboxPage() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: sandboxStatusQueryKey,
    queryFn: fetchSandboxStatus,
    retry: false,
  });
  const runCode = useMutation({
    mutationFn: runSandboxCode,
    onSuccess: (result) => {
      toast[result.success ? "success" : "error"](
        result.success ? "Sandbox code finished" : "Sandbox code exited non-zero",
      );
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const destroySandbox = useMutation({
    mutationFn: destroySandboxContainer,
    onSuccess: async () => {
      runCode.reset();
      await queryClient.invalidateQueries({ queryKey: sandboxStatusQueryKey });
      toast.success("Sandbox destroyed");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const form = useForm({
    defaultValues: {
      code: DEFAULT_CODE,
    },
    onSubmit: async ({ value }) => {
      await runCode.mutateAsync(value.code);
    },
  });

  const result = runCode.data;
  const busy = status.isPending || runCode.isPending || destroySandbox.isPending;

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      <section className="w-full border-b p-4 lg:max-w-md lg:border-b-0 lg:border-r">
        <div className="max-w-md space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <StatusDot status={status.data?.status ?? (status.isError ? "error" : "pending")} />
              <h2 className="text-sm font-semibold">Cloudflare sandbox</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Runs JavaScript inside a local Cloudflare Sandbox container when this app is started
              with the Cloudflare dev command.
            </p>
          </div>

          {status.isError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {status.error.message}
            </div>
          ) : (
            <SandboxStatus status={status.data} />
          )}

          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="code">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>JavaScript</FieldLabel>
                    <Textarea
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      className="min-h-64 font-mono text-xs"
                      spellCheck={false}
                    />
                    <FieldDescription>
                      Written to <code>/workspace/user-code.mjs</code> and executed with Node.
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>
            </FieldGroup>

            <div className="flex flex-wrap gap-2">
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button type="submit" disabled={!canSubmit || isSubmitting || busy}>
                    {runCode.isPending ? "Running..." : "Run code"}
                  </Button>
                )}
              </form.Subscribe>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  form.setFieldValue("code", DEFAULT_CODE);
                  runCode.reset();
                }}
              >
                Reset editor
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => destroySandbox.mutate()}
              >
                Destroy sandbox
              </Button>
            </div>
          </form>
        </div>
      </section>

      <section className="min-h-0 flex-1 p-4">
        <div className="flex h-full min-h-[360px] flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
            <div className="font-medium">Output</div>
            {result && (
              <span className="text-muted-foreground">
                exit {result.exitCode} · {result.durationMs}ms
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {result ? (
              <SandboxOutput result={result} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Run the sample to create a sandbox and execute code in the container.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function SandboxStatus({ status }: { status?: SandboxStatusResponse }) {
  if (!status) {
    return (
      <div className="rounded-lg border p-3 text-sm text-muted-foreground">
        Starting sandbox container...
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">Sandbox ID</span>
        <span className="font-mono text-xs text-muted-foreground">{status.sandboxId}</span>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-5 text-muted-foreground">
        {status.stdout || status.stderr}
      </pre>
    </div>
  );
}

function SandboxOutput({ result }: { result: SandboxRunResponse }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot status={result.success ? "ready" : "error"} />
        <span className="font-medium">{result.success ? "Completed" : "Exited non-zero"}</span>
        <span className="text-muted-foreground">{result.command}</span>
      </div>
      {result.stdout && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">stdout</p>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5">{result.stdout}</pre>
        </div>
      )}
      {result.stderr && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">stderr</p>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-destructive">
            {result.stderr}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "ready"
      ? "bg-green-500"
      : status === "error"
        ? "bg-red-500"
        : "animate-pulse bg-yellow-500";

  return <div className={`size-2 rounded-full ${color}`} />;
}

async function fetchSandboxStatus() {
  const response = await fetch("/api/sandbox", {
    headers: {
      accept: "application/json",
    },
  });

  return parseJsonResponse<SandboxStatusResponse>(response, "Sandbox status request failed");
}

async function runSandboxCode(code: string) {
  const response = await fetch("/api/sandbox/run", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });

  return parseJsonResponse<SandboxRunResponse>(response, "Sandbox run request failed");
}

async function destroySandboxContainer() {
  const response = await fetch("/api/sandbox/destroy", {
    method: "POST",
    headers: {
      accept: "application/json",
    },
  });

  return parseJsonResponse<{ destroyed: true }>(response, "Sandbox destroy request failed");
}

async function parseJsonResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const parsed = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const message = readErrorMessage(parsed) ?? `${fallbackMessage}: ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function readErrorMessage(value: unknown) {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return null;
  }

  const error = value.error;
  return typeof error === "string" ? error : null;
}
