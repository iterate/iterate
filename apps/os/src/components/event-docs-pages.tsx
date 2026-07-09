import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type {
  EventDoc,
  EventReferenceDoc,
  ProcessorDoc,
  ProcessorReferenceDoc,
} from "~/lib/event-docs.ts";

// =============================================================================
// JSON-schema presentation helpers.
//
// The docs pages render the `z.toJSONSchema(...)` output of each event's
// payload schema as a readable field table (name, type, required,
// description) instead of a raw JSON dump. These helpers walk the handful of
// JSON Schema shapes our zod contracts actually produce: objects, records,
// arrays, enums, literals, (discriminated) unions, and nullables.
// =============================================================================

type SchemaFieldRow = {
  children: SchemaFieldRow[];
  description: string | undefined;
  name: string;
  required: boolean;
  typeLabel: string;
};

/** Nesting cap for the field table — deeper shapes fall back to the raw schema block. */
const MAX_FIELD_DEPTH = 5;
const PAYLOAD_PREVIEW_MAX_LENGTH = 88;

function asSchemaObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The `anyOf`/`oneOf` variant list of a schema, or null when it is not a union. */
function schemaVariants(schema: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(schema.anyOf)) return schema.anyOf;
  if (Array.isArray(schema.oneOf)) return schema.oneOf;
  return null;
}

/** Compact TypeScript-flavored type label for one schema node. */
function schemaTypeLabel(value: unknown): string {
  if (value === true || value === undefined) return "any";
  const schema = asSchemaObject(value);
  if (!schema) return "any";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((option) => JSON.stringify(option)).join(" | ");
  }

  const variants = schemaVariants(schema);
  if (variants) {
    const labels = [...new Set(variants.map(schemaTypeLabel))];
    return labels.join(" | ");
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.map(schemaTypeLabel).join(" & ");

  const type = schema.type;
  if (Array.isArray(type)) return type.join(" | ");
  if (type === "array") {
    const itemLabel = schemaTypeLabel(schema.items);
    return itemLabel.includes("|") || itemLabel.includes("&")
      ? `(${itemLabel})[]`
      : `${itemLabel}[]`;
  }
  if (
    type === "object" ||
    (type === undefined && ("properties" in schema || "additionalProperties" in schema))
  ) {
    const properties = asSchemaObject(schema.properties);
    if (properties && Object.keys(properties).length > 0) return "object";
    const additional = schema.additionalProperties;
    if (additional !== undefined && additional !== false) {
      return `Record<string, ${schemaTypeLabel(additional === true ? undefined : additional)}>`;
    }
    return "object";
  }
  if (typeof type === "string") return type;
  return "any";
}

function schemaFieldRows(value: unknown, depth = 0): SchemaFieldRow[] {
  if (depth >= MAX_FIELD_DEPTH) return [];
  const schema = asSchemaObject(value);
  if (!schema) return [];
  const properties = asSchemaObject(schema.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  return Object.entries(properties).map(([name, propertySchema]) => {
    const property = asSchemaObject(propertySchema);
    return {
      children: schemaChildRows(propertySchema, depth + 1),
      description: typeof property?.description === "string" ? property.description : undefined,
      name,
      required: required.has(name),
      typeLabel: schemaTypeLabel(propertySchema),
    };
  });
}

/** Nested rows under one field: object properties, array items, record values, union variants. */
function schemaChildRows(value: unknown, depth: number): SchemaFieldRow[] {
  if (depth >= MAX_FIELD_DEPTH) return [];
  const schema = asSchemaObject(value);
  if (!schema) return [];

  const variants = schemaVariants(schema);
  if (variants) {
    const objectVariants = variants
      .map(asSchemaObject)
      .filter(
        (variant): variant is Record<string, unknown> =>
          variant != null && asSchemaObject(variant.properties) != null,
      );
    if (objectVariants.length === 0) {
      const nonNull = variants.filter((variant) => asSchemaObject(variant)?.type !== "null");
      return nonNull.length === 1 ? schemaChildRows(nonNull[0], depth) : [];
    }
    if (objectVariants.length === 1) return schemaFieldRows(objectVariants[0], depth);
    return objectVariants.map((variant, index) => ({
      children: schemaFieldRows(variant, depth + 1),
      description: typeof variant.description === "string" ? variant.description : undefined,
      name: variantLabel(variant, index),
      // Variants are alternatives, not optional fields — never badge them.
      required: true,
      typeLabel: "object",
    }));
  }

  if (schema.type === "array") return schemaChildRows(schema.items, depth);
  if (asSchemaObject(schema.properties)) return schemaFieldRows(schema, depth);

  const additional = asSchemaObject(schema.additionalProperties);
  if (additional && asSchemaObject(additional.properties)) {
    return [
      {
        children: schemaFieldRows(additional, depth + 1),
        description:
          typeof additional.description === "string" ? additional.description : undefined,
        name: "[key: string]",
        required: false,
        typeLabel: schemaTypeLabel(additional),
      },
    ];
  }
  return [];
}

/** Label a union variant by its discriminator literal when it has one. */
function variantLabel(variant: Record<string, unknown>, index: number): string {
  const properties = asSchemaObject(variant.properties);
  if (properties) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      const property = asSchemaObject(propertySchema);
      if (property && "const" in property) return `${name}: ${JSON.stringify(property.const)}`;
    }
  }
  return `variant ${index + 1}`;
}

/** One-line payload shape summary for listings, e.g. `{ subscriptionKey, delivery, selector? }`. */
function payloadPreview(value: unknown): string {
  const schema = asSchemaObject(value);
  if (!schema) return "";

  const variants = schemaVariants(schema);
  if (variants) {
    const previews = [
      ...new Set(variants.map((variant) => payloadPreview(variant) || schemaTypeLabel(variant))),
    ];
    return truncatePreview(previews.join(" | "));
  }

  const properties = asSchemaObject(schema.properties);
  if (properties) {
    const names = Object.keys(properties);
    if (names.length === 0) {
      const loose =
        schema.additionalProperties !== undefined && schema.additionalProperties !== false;
      return loose ? "{ …any }" : "{}";
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const body = names.map((name) => (required.has(name) ? name : `${name}?`)).join(", ");
    return truncatePreview(`{ ${body} }`);
  }
  return truncatePreview(schemaTypeLabel(schema));
}

function truncatePreview(preview: string): string {
  if (preview.length <= PAYLOAD_PREVIEW_MAX_LENGTH) return preview;
  return `${preview.slice(0, PAYLOAD_PREVIEW_MAX_LENGTH - 1)}…`;
}

// =============================================================================
// Pages.
// =============================================================================

export function EventDocsIndexPage(input: {
  eventDocs: readonly EventDoc[];
  processorDocs: readonly ProcessorDoc[];
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const sections = useMemo(() => {
    return input.processorDocs
      .map((processor) => {
        const processorMatches =
          normalizedQuery.length === 0 ||
          processor.contractSlug.toLowerCase().includes(normalizedQuery) ||
          processor.slug.toLowerCase().includes(normalizedQuery) ||
          (processor.description ?? "").toLowerCase().includes(normalizedQuery);
        const events = processorMatches
          ? processor.events
          : processor.events.filter((event) => eventMatchesQuery(event, normalizedQuery));
        return { events, processor, processorMatches };
      })
      .filter((section) => section.processorMatches || section.events.length > 0);
  }, [input.processorDocs, normalizedQuery]);

  const visibleEventCount = sections.reduce((count, section) => count + section.events.length, 0);

  return (
    <EventDocsShell>
      <header className="space-y-3 border-b px-6 py-8 md:px-10">
        <p className="text-sm font-medium uppercase tracking-normal text-muted-foreground">
          events.iterate.com
        </p>
        <h1 className="max-w-3xl text-3xl font-semibold tracking-normal text-foreground">
          Event type reference
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Public documentation generated from the stream processor contracts in OS: every processor,
          the event types it owns, their payload schemas and example events, and how processors
          consume, emit, and depend on each other.
        </p>
        <p className="text-xs text-muted-foreground">
          {input.processorDocs.length} processors · {input.eventDocs.length} event types
        </p>
      </header>
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-8">
          <input
            type="search"
            value={query}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
            placeholder="Filter by event type, processor, or description…"
            aria-label="Filter event types"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</p>
          ) : (
            sections.map(({ events, processor }) => (
              <section
                key={processor.contractSlug}
                id={`processor-${processor.slug}`}
                className="space-y-3"
              >
                <div className="space-y-1">
                  <h2 className="font-mono text-base font-semibold">
                    <Link
                      to="/docs/streams/processors/$processorSlug"
                      params={processor.routeParams}
                      className="hover:underline"
                    >
                      {processor.contractSlug}
                    </Link>
                    {processor.version ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        v{processor.version}
                      </span>
                    ) : null}
                  </h2>
                  {processor.description ? (
                    <p className="text-sm text-muted-foreground">{processor.description}</p>
                  ) : null}
                </div>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This processor owns no event types.
                  </p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {events.map((event) => (
                      <EventListRow key={event.type} event={event} />
                    ))}
                  </div>
                )}
              </section>
            ))
          )}
          {normalizedQuery.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Showing {visibleEventCount} of {input.eventDocs.length} event types.
            </p>
          ) : null}
        </section>
        <aside className="space-y-3">
          <h2 className="text-sm font-semibold">Processors</h2>
          <div className="divide-y rounded-md border">
            {input.processorDocs.map((processor) => (
              <Link
                key={processor.contractSlug}
                to="/docs/streams/processors/$processorSlug"
                params={processor.routeParams}
                className="block px-4 py-3 hover:bg-muted/60"
              >
                <span className="block font-mono text-sm text-foreground">
                  {processor.contractSlug}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {processor.events.length} owned ·{" "}
                  {processor.consumesAllEvents
                    ? "consumes *"
                    : `consumes ${processor.consumes.length}`}{" "}
                  · emits {processor.emits.length}
                </span>
              </Link>
            ))}
          </div>
        </aside>
      </main>
    </EventDocsShell>
  );
}

function eventMatchesQuery(event: EventDoc, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true;
  return (
    event.type.toLowerCase().includes(normalizedQuery) ||
    (event.description ?? "").toLowerCase().includes(normalizedQuery)
  );
}

export function ProcessorOverviewPage({ processor }: { processor: ProcessorDoc }) {
  return (
    <EventDocsShell>
      <EventDocsHeader
        eyebrow="Stream processor"
        title={processor.contractSlug}
        description={processor.description}
      />
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-6">
          <DocSection title="Owned event types">
            {processor.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">This processor owns no event types.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {processor.events.map((event) => (
                  <EventListRow key={event.type} event={event} showCrossReferences />
                ))}
              </div>
            )}
          </DocSection>
          <DocSection title="Consumes">
            {processor.consumesAllEvents ? (
              <p className="text-sm text-muted-foreground">
                Consumes <span className="font-mono">*</span> — every event on the stream reaches
                this processor's reducer
                {processor.consumes.length > 0 ? ", with these types named explicitly:" : "."}
              </p>
            ) : null}
            <EventReferenceList
              events={processor.consumes}
              emptyLabel={processor.consumesAllEvents ? null : "This processor consumes no events."}
              ownContractSlug={processor.contractSlug}
            />
          </DocSection>
          <DocSection title="Emits">
            <EventReferenceList
              events={processor.emits}
              emptyLabel="This processor emits no events."
              ownContractSlug={processor.contractSlug}
            />
          </DocSection>
        </section>
        <aside className="space-y-4">
          <InfoList
            items={[
              ["Contract slug", processor.contractSlug],
              ["Version", processor.version ?? "unversioned"],
              ["Public path", processor.href],
              ["Owned events", String(processor.events.length)],
              [
                "Consumes",
                processor.consumesAllEvents ? "* (all events)" : String(processor.consumes.length),
              ],
              ["Emits", String(processor.emits.length)],
            ]}
          />
          <ProcessorLinkList title="Depends on" processors={processor.dependencies} />
          <ProcessorLinkList title="Depended on by" processors={processor.dependents} />
        </aside>
      </main>
    </EventDocsShell>
  );
}

export function EventDocPage({ event }: { event: EventDoc }) {
  return (
    <EventDocsShell>
      <EventDocsHeader
        eyebrow="Event type"
        title={event.type}
        description={event.description ?? "No description provided."}
      />
      <main className="grid gap-8 px-6 py-8 md:grid-cols-[minmax(0,1fr)_18rem] md:px-10">
        <section className="space-y-6">
          <DocSection title="Payload schema">
            <SchemaView schema={event.payloadJsonSchema} />
          </DocSection>
          <DocSection title="Examples">
            {event.examples.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No examples documented for this event type yet.
              </p>
            ) : (
              <div className="space-y-4">
                {event.examples.map((example, index) => (
                  <div key={example.description} className="space-y-2">
                    <p className="text-sm text-muted-foreground">{example.description}</p>
                    <JsonBlock value={example.payload} />
                    {index === 0 ? (
                      <CommittedEventExample event={event} payload={example.payload} />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </DocSection>
        </section>
        <aside className="space-y-4">
          <InfoList
            items={[
              ["URL path", event.href],
              ["Owned by", event.processor.contractSlug],
              ["Event path", event.eventPath],
              ["Examples", String(event.examples.length)],
            ]}
          />
          <DocSection title="Owned by">
            <ProcessorLink processor={event.processor} />
          </DocSection>
          <ProcessorLinkList title="Emitted by" processors={event.emittedBy} />
          <ProcessorLinkList
            title="Consumed by"
            processors={event.consumedBy}
            footnote="Processors that consume every event (*) are not listed."
          />
        </aside>
      </main>
    </EventDocsShell>
  );
}

/**
 * The first example payload wrapped in the committed-event envelope, so
 * readers see what an actual stream row for this type looks like. Offset,
 * createdAt, and path are assigned by the stream at commit time; the values
 * here are illustrative.
 */
function CommittedEventExample({ event, payload }: { event: EventDoc; payload: unknown }) {
  const committedEvent = {
    type: event.type,
    payload,
    metadata: {},
    source: {
      processor: {
        slug: event.processor.contractSlug,
        version: event.processor.version ?? "0.1.0",
      },
    },
    offset: 42,
    createdAt: "2026-07-09T12:34:56.789Z",
    path: "<stream path>",
  };
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
        As a committed stream event (envelope fields are illustrative)
      </summary>
      <div className="border-t p-2">
        <JsonBlock value={committedEvent} bare />
      </div>
    </details>
  );
}

// =============================================================================
// Shared building blocks.
// =============================================================================

function EventDocsShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}

function EventDocsHeader(input: { description?: string; eyebrow: string; title: string }) {
  return (
    <header className="space-y-3 border-b px-6 py-8 md:px-10">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        events.iterate.com
      </Link>
      <p className="text-sm font-medium uppercase tracking-normal text-muted-foreground">
        {input.eyebrow}
      </p>
      <h1 className="max-w-4xl break-words font-mono text-2xl font-semibold tracking-normal text-foreground">
        {input.title}
      </h1>
      {input.description ? (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{input.description}</p>
      ) : null}
    </header>
  );
}

function DocSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** One event in a listing: link, description, payload shape preview, cross-reference counts. */
function EventListRow({
  event,
  showCrossReferences = false,
}: {
  event: EventDoc;
  showCrossReferences?: boolean;
}) {
  const preview = payloadPreview(event.payloadJsonSchema);
  const meta: string[] = [];
  if (event.examples.length > 0) {
    meta.push(`${event.examples.length} example${event.examples.length === 1 ? "" : "s"}`);
  }
  if (showCrossReferences) {
    if (event.emittedBy.length > 0) meta.push(`emitted by ${event.emittedBy.length}`);
    if (event.consumedBy.length > 0) meta.push(`consumed by ${event.consumedBy.length}`);
  }

  return (
    <Link
      to="/docs/streams/processors/$processorSlug/events/$"
      params={event.routeParams}
      className="block px-4 py-3 hover:bg-muted/60"
    >
      <span className="block break-all font-mono text-sm text-foreground">{event.type}</span>
      {event.description ? (
        <span className="mt-1 block text-sm text-muted-foreground">{event.description}</span>
      ) : null}
      {preview ? (
        <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
          payload: {preview}
        </span>
      ) : null}
      {meta.length > 0 ? (
        <span className="mt-1 block text-xs text-muted-foreground">{meta.join(" · ")}</span>
      ) : null}
    </Link>
  );
}

function EventReferenceList(input: {
  emptyLabel: string | null;
  events: readonly EventReferenceDoc[];
  /** Rows owned by other processors get an "owned by" chip naming their contract. */
  ownContractSlug: string;
}) {
  if (input.events.length === 0) {
    return input.emptyLabel ? (
      <p className="text-sm text-muted-foreground">{input.emptyLabel}</p>
    ) : null;
  }
  return (
    <div className="divide-y rounded-md border">
      {input.events.map((event) => {
        const ownedElsewhere =
          event.ownerContractSlug != null && event.ownerContractSlug !== input.ownContractSlug;
        const body = (
          <>
            <span className="block break-all font-mono text-sm">
              {event.type}
              {ownedElsewhere ? (
                <span className="ml-2 rounded-sm border px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
                  owned by {event.ownerContractSlug}
                </span>
              ) : null}
            </span>
            {event.description ? (
              <span className="mt-1 block text-sm text-muted-foreground">{event.description}</span>
            ) : null}
          </>
        );
        return event.href && event.routeParams ? (
          <Link
            key={event.type}
            to="/docs/streams/processors/$processorSlug/events/$"
            params={event.routeParams}
            className="block px-4 py-3 hover:bg-muted/60"
          >
            {body}
          </Link>
        ) : (
          <div key={event.type} className="px-4 py-3">
            {body}
          </div>
        );
      })}
    </div>
  );
}

function ProcessorLinkList(input: {
  footnote?: string;
  processors: readonly ProcessorReferenceDoc[];
  title: string;
}) {
  if (input.processors.length === 0) return null;
  return (
    <DocSection title={input.title}>
      <div className="space-y-2">
        {input.processors.map((processor) => (
          <ProcessorLink key={processor.contractSlug} processor={processor} />
        ))}
      </div>
      {input.footnote ? <p className="text-xs text-muted-foreground">{input.footnote}</p> : null}
    </DocSection>
  );
}

function ProcessorLink({ processor }: { processor: ProcessorReferenceDoc }) {
  return (
    <Link
      to="/docs/streams/processors/$processorSlug"
      params={processor.routeParams}
      className="block rounded-md border px-3 py-2 hover:bg-muted/60"
    >
      <span className="block font-mono text-sm">{processor.contractSlug}</span>
      {processor.description ? (
        <span className="mt-1 block text-xs text-muted-foreground">{processor.description}</span>
      ) : null}
    </Link>
  );
}

function InfoList({ items }: { items: readonly [string, string][] }) {
  return (
    <dl className="divide-y rounded-md border text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="space-y-1 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Field table plus collapsible raw JSON schema for one event payload. */
function SchemaView({ schema }: { schema: unknown }) {
  const schemaObject = asSchemaObject(schema);
  const variants = schemaObject ? schemaVariants(schemaObject) : null;
  const rows = schemaFieldRows(schema);
  // zod's `.loose()` objects emit `additionalProperties: {}` (any schema
  // other than `false` means extra keys are accepted).
  const allowsAdditionalProperties =
    schemaObject != null &&
    schemaObject.additionalProperties !== undefined &&
    schemaObject.additionalProperties !== false;

  return (
    <div className="space-y-3">
      {variants ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">One of {variants.length} shapes:</p>
          {variants.map((variant, index) => {
            const variantObject = asSchemaObject(variant);
            const variantRows = schemaFieldRows(variant);
            return (
              <div
                key={variantObject ? variantLabel(variantObject, index) : index}
                className="rounded-md border"
              >
                <p className="border-b px-4 py-2 font-mono text-xs text-muted-foreground">
                  {variantObject ? variantLabel(variantObject, index) : `variant ${index + 1}`}
                </p>
                {variantRows.length > 0 ? (
                  <FieldRows rows={variantRows} />
                ) : (
                  <p className="px-4 py-3 font-mono text-sm text-muted-foreground">
                    {schemaTypeLabel(variant)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : rows.length > 0 ? (
        <div className="rounded-md border">
          <FieldRows rows={rows} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {allowsAdditionalProperties
            ? "Free-form payload — any JSON object is accepted."
            : "This event carries no payload fields."}
        </p>
      )}
      {rows.length > 0 && allowsAdditionalProperties ? (
        <p className="text-xs text-muted-foreground">
          Additional properties beyond the listed fields are allowed.
        </p>
      ) : null}
      <details className="rounded-md border">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
          Raw JSON schema
        </summary>
        <div className="border-t p-2">
          <JsonBlock value={schema} bare />
        </div>
      </details>
    </div>
  );
}

function FieldRows({ rows, depth = 0 }: { depth?: number; rows: readonly SchemaFieldRow[] }) {
  return (
    <div className={depth === 0 ? "divide-y" : "divide-y border-t"}>
      {rows.map((row) => (
        <div key={row.name} className="py-2" style={{ paddingLeft: `${depth * 1.25 + 1}rem` }}>
          <div className="flex flex-wrap items-baseline gap-x-2 pr-4">
            <span className="font-mono text-sm text-foreground">{row.name}</span>
            <span className="break-all font-mono text-xs text-muted-foreground">
              {row.typeLabel}
            </span>
            {row.required ? null : (
              <span className="rounded-sm border px-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                optional
              </span>
            )}
          </div>
          {row.description ? (
            <p className="mt-1 pr-4 text-sm text-muted-foreground">{row.description}</p>
          ) : null}
          {row.children.length > 0 ? (
            <div className="mt-2 -ml-0">
              <FieldRows rows={row.children} depth={depth + 1} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function JsonBlock({ bare = false, value }: { bare?: boolean; value: unknown }) {
  return (
    <pre
      className={
        bare
          ? "max-h-[32rem] overflow-auto rounded-md bg-muted/40 p-4 text-xs leading-5"
          : "max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-5"
      }
    >
      <code>{JSON.stringify(value, null, 2)}</code>
    </pre>
  );
}
