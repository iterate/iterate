import { useForm } from "@tanstack/react-form";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import {
  deriveDurableObjectNameFromStructuredName,
  getInitializedDoStub,
  listD1ObjectCatalogRecords,
  type D1ObjectCatalogRecord,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
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
import {
  buildCounterExplorerLinks,
  buildCounterInitParams,
  buildCounterPublicPath,
  COUNTER_DURABLE_OBJECT_CLASS_NAME,
  CreateCounterFormValues,
  type CounterInitParams,
} from "~/lib/counter-durable-objects.ts";

type CounterCatalogEntry = D1ObjectCatalogRecord<CounterInitParams> & {
  publicPath: string;
  explorerLinks: ReturnType<typeof buildCounterExplorerLinks>;
};

const DEFAULT_COUNTER_FORM_VALUES = {
  scope: "demo",
  variant: "primary",
} satisfies CreateCounterFormValues;

const listCounterDurableObjects = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  if (!context.workerEnv) {
    return {
      available: false,
      counters: [],
    };
  }

  const records = await listD1ObjectCatalogRecords<CounterInitParams>(context.workerEnv.DB, {
    className: COUNTER_DURABLE_OBJECT_CLASS_NAME,
  });

  return {
    available: true,
    counters: records.map((record) => {
      const publicPath = buildCounterPublicPath(record.name);

      return {
        ...record,
        publicPath,
        explorerLinks: buildCounterExplorerLinks(publicPath),
      };
    }),
  };
});

const createCounterDurableObject = createServerFn({ method: "POST" })
  .inputValidator(CreateCounterFormValues)
  .handler(async ({ context, data }) => {
    if (!context.workerEnv) {
      throw new Error("Counter Durable Objects are only available in the Cloudflare runtime.");
    }

    const initParams = buildCounterInitParams(data);
    const name = deriveDurableObjectNameFromStructuredName({
      structuredName: initParams,
    });
    await getInitializedDoStub({
      allowCreate: true,
      namespace: context.workerEnv.EXAMPLE_COUNTER,
      name: initParams,
    });

    return {
      name,
    };
  });

export const Route = createFileRoute("/_app/durable-objects")({
  staticData: {
    breadcrumb: "Durable Objects",
  },
  loader: async () => await listCounterDurableObjects(),
  component: DurableObjectsPage,
});

function DurableObjectsPage() {
  const navigate = useNavigate();
  const createCounter = useServerFn(createCounterDurableObject);
  const { available, counters } = Route.useLoaderData();
  const form = useForm({
    defaultValues: DEFAULT_COUNTER_FORM_VALUES,
    validators: {
      onChange: CreateCounterFormValues,
      onSubmit: CreateCounterFormValues,
    },
    onSubmit: async ({ value }) => {
      try {
        const created = await createCounter({ data: CreateCounterFormValues.parse(value) });
        await navigate({
          to: "/counters/$name",
          params: { name: created.name },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Counter creation failed.");
      }
    },
  });

  return (
    <section className="space-y-6 p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Counter Durable Objects</h2>
        <p className="text-sm text-muted-foreground">
          Initialized counters are cataloged in D1 and expose their own KV and SQL inspectors.
        </p>
      </div>

      {!available && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Counter Durable Objects are only available in the Cloudflare runtime.
        </p>
      )}

      <form
        className="space-y-4 rounded-lg border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="scope">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Scope</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="demo"
                  />
                  <FieldDescription>First identity dimension for the counter.</FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>

          <form.Field name="variant">
            {(field) => {
              const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;

              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Variant</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="primary"
                  />
                  <FieldDescription>Second identity dimension for the counter.</FieldDescription>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              );
            }}
          </form.Field>
        </FieldGroup>

        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!available || !canSubmit || isSubmitting}>
              {isSubmitting ? "Creating..." : "Create counter"}
            </Button>
          )}
        </form.Subscribe>
      </form>

      <div className="space-y-3">
        {counters.map((counter: CounterCatalogEntry) => (
          <div
            key={counter.name}
            className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4 text-sm"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Link
                to="/counters/$name"
                params={{ name: counter.name }}
                className="block truncate font-medium hover:underline"
              >
                {counter.name}
              </Link>
              <p className="text-muted-foreground">
                {counter.structuredName.scope} · {counter.structuredName.variant} · last woken{" "}
                {new Date(counter.lastWokenAt).toLocaleString()}
              </p>
              <CounterInspectorLinks links={counter.explorerLinks} />
            </div>
          </div>
        ))}
      </div>

      {available && counters.length === 0 && (
        <p className="text-sm text-muted-foreground">No counters yet. Create one above.</p>
      )}
    </section>
  );
}

function CounterInspectorLinks({ links }: { links: ReturnType<typeof buildCounterExplorerLinks> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <a className="text-primary hover:underline" href={links.kv} target="_blank" rel="noreferrer">
        KV
      </a>
      <a
        className="text-primary hover:underline"
        href={links.kvJson}
        target="_blank"
        rel="noreferrer"
      >
        KV JSON
      </a>
      <a className="text-primary hover:underline" href={links.sql} target="_blank" rel="noreferrer">
        SQL
      </a>
    </div>
  );
}
