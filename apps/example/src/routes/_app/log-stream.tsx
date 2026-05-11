import { useEffect, useState } from "react";
import { ORPCError } from "@orpc/client";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import {
  RandomLogStreamFormSchema,
  type RandomLogStreamFormValues,
  type RandomLogStreamRequest,
} from "@iterate-com/example-contract";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@iterate-com/ui/components/radio-group";
import { createBrowserOpenApiClient, createBrowserWebSocketClient } from "~/orpc/client.ts";

type StreamStatus = "idle" | "connecting" | "streaming" | "completed" | "error";
type StreamTransport = "openapi" | "websocket";
type ActiveStream = {
  request: RandomLogStreamRequest;
  transport: StreamTransport;
};

const STREAM_TRANSPORT_OPTIONS = [
  {
    value: "openapi",
    label: "OpenAPI",
    description: "Use the browser fetch/OpenAPI client against the /api HTTP route.",
  },
  {
    value: "websocket",
    label: "WebSocket",
    description: "Use the browser websocket oRPC client against /api/orpc-ws.",
  },
] as const satisfies ReadonlyArray<{
  value: StreamTransport;
  label: string;
  description: string;
}>;

const DEFAULT_VALUES: RandomLogStreamFormValues = {
  count: "20",
  minDelayMs: "100",
  maxDelayMs: "500",
};
const DEFAULT_TRANSPORT: StreamTransport = "openapi";

export const Route = createFileRoute("/_app/log-stream")({
  ssr: false,
  staticData: {
    breadcrumb: "Log Stream",
  },
  component: LogStreamPage,
});

function LogStreamPage() {
  const [transport, setTransport] = useState<StreamTransport>(DEFAULT_TRANSPORT);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: DEFAULT_VALUES,
    validators: {
      onChange: RandomLogStreamFormSchema,
      onSubmit: RandomLogStreamFormSchema,
    },
    onSubmit: async ({ value }) => {
      const request = RandomLogStreamFormSchema.parse(value);
      setLastError(null);
      setLines([]);
      setActiveStream({
        request,
        transport,
      });
    },
  });

  useEffect(() => {
    if (!activeStream) {
      return;
    }

    const controller = new AbortController();
    let isCurrent = true;
    let iterator: AsyncIterator<string> | undefined;
    const transportClient = createTransportClient(activeStream.transport);

    setStatus("connecting");

    void (async () => {
      try {
        const stream = await transportClient.client.test.randomLogStream(activeStream.request, {
          signal: controller.signal,
        });
        iterator = stream[Symbol.asyncIterator]();

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        setStatus("streaming");

        for await (const line of stream) {
          if (!isCurrent || controller.signal.aborted) {
            return;
          }

          setLines((previous) => {
            const updated = [...previous, line];
            return updated.length > 500 ? updated.slice(-500) : updated;
          });
        }

        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        setStatus("completed");
      } catch (error) {
        if (!isCurrent || controller.signal.aborted) {
          return;
        }

        const message = error instanceof ORPCError ? error.message : String(error);
        setLastError(message);
        setStatus("error");
      }
    })();

    return () => {
      isCurrent = false;
      controller.abort();
      void iterator?.return?.();
      transportClient.close();
    };
  }, [activeStream]);

  const clearOutput = () => {
    setActiveStream(null);
    setLines([]);
    setLastError(null);
    setStatus("idle");
  };

  const selectedTransport = activeStream?.transport ?? transport;

  return (
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      <section className="w-full border-b p-4 lg:max-w-md lg:border-b-0 lg:border-r">
        <div className="max-w-md space-y-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Random log stream</h2>
              <Badge variant="outline">No SSR</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              This route sets <code>ssr: false</code> in TanStack Start so you can compare the
              browser OpenAPI and websocket oRPC clients while streaming the same async iterator.
            </p>
          </div>

          <form
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Transport</FieldLabel>
                <FieldDescription>
                  Choose whether the stream should use the browser OpenAPI client or the websocket
                  oRPC client.
                </FieldDescription>
                <RadioGroup
                  value={transport}
                  onValueChange={(value) => {
                    if (isStreamTransport(value)) {
                      setTransport(value);
                    }
                  }}
                  className="mt-3 gap-2"
                >
                  {STREAM_TRANSPORT_OPTIONS.map((option) => {
                    const id = `transport-${option.value}`;
                    const isSelected = transport === option.value;

                    return (
                      <label
                        key={option.value}
                        htmlFor={id}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                          isSelected ? "border-primary bg-accent/30" : "hover:bg-accent/20"
                        }`}
                      >
                        <RadioGroupItem id={id} value={option.value} />
                        <div className="space-y-1">
                          <div className="text-sm font-medium leading-none">{option.label}</div>
                          <p className="text-sm text-muted-foreground">{option.description}</p>
                        </div>
                      </label>
                    );
                  })}
                </RadioGroup>
              </Field>

              <form.Field name="count">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Number of random numbers</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        type="number"
                        inputMode="numeric"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                        placeholder="20"
                      />
                      <FieldDescription>How many random log lines to emit.</FieldDescription>
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              </form.Field>

              <form.Field name="minDelayMs">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Minimum delay (ms)</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        type="number"
                        inputMode="numeric"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                        placeholder="100"
                      />
                      <FieldDescription>Shortest delay between yielded lines.</FieldDescription>
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              </form.Field>

              <form.Field name="maxDelayMs">
                {(field) => {
                  const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                  return (
                    <Field data-invalid={isInvalid}>
                      <FieldLabel htmlFor={field.name}>Maximum delay (ms)</FieldLabel>
                      <Input
                        id={field.name}
                        name={field.name}
                        type="number"
                        inputMode="numeric"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={isInvalid}
                        placeholder="500"
                      />
                      <FieldDescription>Must be greater than the minimum delay.</FieldDescription>
                      {isInvalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  );
                }}
              </form.Field>
            </FieldGroup>

            {lastError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {lastError}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button type="submit" disabled={!canSubmit || isSubmitting}>
                    {isSubmitting ? "Starting..." : "Start stream"}
                  </Button>
                )}
              </form.Subscribe>

              <Button type="button" variant="ghost" onClick={clearOutput}>
                Clear output
              </Button>
            </div>
          </form>
        </div>
      </section>

      <section className="min-h-0 flex-1 p-4">
        <div className="flex h-full min-h-[320px] flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <StatusDot status={status} />
              <span className="font-medium">{statusLabel(status)}</span>
            </div>
            <span className="text-muted-foreground">
              {transportLabel(selectedTransport)} · {lines.length} lines
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            {lines.length > 0 ? (
              <pre className="wrap-break-word whitespace-pre-wrap font-mono text-xs leading-5">
                {lines.join("\n")}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                Start a stream to watch the async iterator produce log lines here.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function StatusDot({ status }: { status: StreamStatus }) {
  const color =
    status === "streaming"
      ? "bg-green-500"
      : status === "connecting"
        ? "animate-pulse bg-yellow-500"
        : status === "error"
          ? "bg-red-500"
          : "bg-muted-foreground/40";

  return <div className={`size-2 rounded-full ${color}`} />;
}

function statusLabel(status: StreamStatus) {
  if (status === "connecting") return "Connecting";
  if (status === "streaming") return "Streaming";
  if (status === "completed") return "Completed";
  if (status === "error") return "Stream error";
  return "Idle";
}

function createTransportClient(transport: StreamTransport) {
  if (transport === "websocket") {
    return createBrowserWebSocketClient();
  }

  return {
    client: createBrowserOpenApiClient(),
    close: () => {},
  };
}

function isStreamTransport(value: string): value is StreamTransport {
  return value === "openapi" || value === "websocket";
}

function transportLabel(transport: StreamTransport) {
  if (transport === "websocket") return "WebSocket";
  return "OpenAPI";
}
