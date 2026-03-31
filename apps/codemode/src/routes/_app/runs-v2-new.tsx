import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, Sparkles, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { SourceCodeBlock } from "@iterate-com/ui/components/source-code-block";
import { z } from "zod";
import { HeaderActions } from "~/components/header-actions.tsx";
import { CODEMODE_EXAMPLES, CODEMODE_V2_STARTER } from "~/lib/codemode-v2.ts";
import { runsQueryKey } from "~/lib/runs.ts";
import { orpcClient } from "~/orpc/client.ts";

const RunFunctionForm = z.object({
  code: z.string().trim().min(1, "Code is required"),
});

export const Route = createFileRoute("/_app/runs-v2-new")({
  staticData: {
    breadcrumb: "Codemode",
  },
  component: NewDeterministicRunPage,
});

function NewDeterministicRunPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isCtxSheetOpen, setIsCtxSheetOpen] = useState(false);
  const ctxTypeDefinitionQuery = useQuery({
    queryKey: ["codemode-ctx-type-definition"],
    queryFn: () => orpcClient.ctxTypeDefinition({}),
    placeholderData: "Loading ctx type definitions...",
  });
  const runMutation = useMutation({
    mutationFn: (input: { code: string }) => orpcClient.runV2(input),
    onError: (error) => {
      toast.error(readErrorMessage(error));
    },
  });

  const form = useForm({
    defaultValues: {
      code: CODEMODE_V2_STARTER,
    },
    validators: {
      onChange: RunFunctionForm,
      onSubmit: RunFunctionForm,
    },
    onSubmit: async ({ value }) => {
      const run = await runMutation.mutateAsync({
        code: value.code.trim(),
      });

      await queryClient.invalidateQueries({ queryKey: runsQueryKey });
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    },
  });

  return (
    <section className="w-full space-y-6 p-4">
      <HeaderActions>
        <Button type="button" variant="outline" onClick={() => setIsCtxSheetOpen(true)}>
          See <code>ctx</code> types
        </Button>
      </HeaderActions>

      <div className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4" />
              <span>Codemode</span>
            </div>
            <p className="max-w-4xl text-sm text-muted-foreground">
              Write an{" "}
              <code>
                async ({"{ ctx }"}) =&gt; {"{ ... }"}
              </code>{" "}
              function. It runs in a Cloudflare Dynamic Worker with outbound fetch blocked and a
              typed, injected <code>ctx</code> for events, example, semaphore, and ingress-proxy.
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => form.setFieldValue("code", CODEMODE_V2_STARTER)}
          >
            Reset starter
          </Button>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="code">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Source</FieldLabel>
                    <SourceCodeBlock
                      code={field.state.value}
                      language="typescript"
                      editable={true}
                      onChange={field.handleChange}
                      className="min-h-[34rem]"
                    />
                    <FieldDescription>
                      Return a value to save it with the run. Throwing is captured separately.
                    </FieldDescription>
                    {isInvalid ? <FieldError errors={field.state.meta.errors} /> : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>

          <div className="flex flex-wrap gap-2">
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Running..." : "Run codemode"}
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      </div>

      <div className="space-y-3 rounded-xl border bg-card p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Working notes</p>
          <p className="text-sm text-muted-foreground">
            <code>console.log</code> is captured, network egress is blocked, and all four injected
            services are live in production.
          </p>
        </div>
        <SourceCodeBlock
          code={`async ({ ctx }) => {
  const ping = await ctx.example.ping({});
  const streams = await ctx.events.listStreams({});
  const resources = await ctx.semaphore.resources.list({});
  const routes = await ctx.ingressProxy.routes.list({ limit: 1, offset: 0 });

  return {
    ping,
    streams: streams.length,
    resources: resources.length,
    routes: routes.total,
  };
};`}
          language="typescript"
          className="min-h-52"
        />
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Copy-paste examples</p>
          <p className="text-sm text-muted-foreground">
            Use one directly or paste pieces into the editor above.
          </p>
        </div>

        <div className="grid gap-4 2xl:grid-cols-3 xl:grid-cols-2">
          {CODEMODE_EXAMPLES.map((example) => (
            <article key={example.id} className="space-y-3 rounded-xl border bg-card p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">{example.title}</p>
                <p className="text-sm text-muted-foreground">{example.description}</p>
              </div>

              <SourceCodeBlock code={example.code} language="typescript" className="min-h-64" />

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    form.setFieldValue("code", example.code);
                    toast.success(`Loaded "${example.title}" into the editor`);
                  }}
                >
                  <Wand2 className="size-4" />
                  Use example
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void copySnippet(example.code, example.title)}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <Sheet open={isCtxSheetOpen} onOpenChange={setIsCtxSheetOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:sm:w-[min(96vw,120rem)] data-[side=right]:sm:max-w-[min(96vw,120rem)]">
          <SheetHeader className="space-y-2 border-b pr-14">
            <SheetTitle>
              <span>Injected </span>
              <code>ctx</code>
              <span> types</span>
            </SheetTitle>
            <SheetDescription>
              Full TypeScript definition of the runtime interface available to codemode snippets.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-hidden p-4">
            <SourceCodeBlock
              code={ctxTypeDefinitionQuery.data ?? "Loading ctx type definitions..."}
              language="typescript"
              className="h-full min-h-0"
            />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}

async function copySnippet(code: string, title: string) {
  try {
    await navigator.clipboard.writeText(code);
    toast.success(`Copied "${title}"`);
  } catch {
    toast.error(`Failed to copy "${title}"`);
  }
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
