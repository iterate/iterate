import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  RefreshCw,
  Play,
  ChevronDown,
  ChevronRight,
  Circle,
  ArrowUpDown,
  Filter,
  X,
  Link2,
  ArrowRight,
} from "lucide-react";
import { z } from "zod/v4";
import { ms, parse as msParse } from "ms";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { SerializedObjectCodeBlock } from "../../components/serialized-object-code-block.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../components/ui/sheet.tsx";
import { cn } from "@/lib/utils.ts";

const Filters = z.object({
  sort: z.enum(["asc", "desc"]).optional().catch("desc"),
  event: z.string().optional(),
  consumer: z.string().optional(),
  status: z.enum(["pending", "success", "retrying", "failed"]).optional(),
  statusMode: z.enum(["some", "all"]).optional().catch("some"),
  ageMin: z.string().optional(),
  ageMax: z.string().optional(),
  readMin: z.string().optional(),
  readMax: z.string().optional(),
  resMin: z.string().optional(),
  resMax: z.string().optional(),
  payload: z.string().optional(),
  page: z.number().optional().catch(0),
  // Related-events timeline
  relatedKey: z.string().optional(),
  relatedValue: z.string().optional(),
});

type Filters = z.infer<typeof Filters>;

export const Route = createFileRoute("/_auth/admin/outbox")({
  validateSearch: Filters,
  component: OutboxPage,
});

// --- Types ---

type QueueMessage = {
  msg_id: number | string;
  enqueued_at: string;
  vt: string;
  read_ct: number;
  message: {
    event_name: string;
    consumer_name: string;
    event_id: number;
    event_payload: Record<string, unknown>;
    event_context?: Record<string, unknown>;
    processing_results: unknown[];
    status?: ConsumerStatus;
  };
};

type ConsumerStatus = "pending" | "success" | "retrying" | "failed";

type EventWithConsumers = {
  id: number;
  name: string;
  payload: Record<string, unknown>;
  context?: { causedBy?: { eventId: number; consumerName: string; jobId: number | string } };
  createdAt: Date;
  updatedAt: Date;
  consumers: QueueMessage[];
  aggregateStatus: ConsumerStatus;
};

// --- Helpers ---

const STATUS_COLORS: Record<ConsumerStatus, string> = {
  pending: "text-yellow-500 fill-yellow-500",
  success: "text-green-500 fill-green-500",
  retrying: "text-orange-500 fill-orange-500",
  failed: "text-red-500 fill-red-500",
};

function StatusDot({ status }: { status: ConsumerStatus }) {
  return <Circle className={cn("h-2.5 w-2.5", STATUS_COLORS[status])} />;
}

function formatAge(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  if (diff < 1000) return "<1s";
  return ms(diff, { long: true });
}

function parseMsDuration(input: string): number | null {
  if (!input.trim()) return null;
  try {
    return msParse(input.trim());
  } catch {
    return null;
  }
}

function aggregateStatus(consumers: QueueMessage[]): ConsumerStatus {
  if (consumers.length === 0) return "pending";
  const statuses = consumers.map((c) => c.message.status ?? "pending");
  if (statuses.every((s) => s === "success")) return "success";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "retrying")) return "retrying";
  return "pending";
}

// --- Filter state ---

const DEFAULT_FILTERS: Filters = Filters.parse({});

/** Convert UI filter state to server input params */
function filtersToInput(filters: Filters) {
  const ageMinMs = filters.ageMin ? parseMsDuration(filters.ageMin) : undefined;
  const ageMaxMs = filters.ageMax ? parseMsDuration(filters.ageMax) : undefined;
  const readCountMin = filters.readMin ? parseInt(filters.readMin, 10) : undefined;
  const readCountMax = filters.readMax ? parseInt(filters.readMax, 10) : undefined;
  const resolutionMinMs = filters.resMin ? parseMsDuration(filters.resMin) : undefined;
  const resolutionMaxMs = filters.resMax ? parseMsDuration(filters.resMax) : undefined;

  let payloadContains: string | undefined;
  if (filters.payload?.trim()) {
    try {
      JSON.parse(filters.payload.trim());
      payloadContains = filters.payload.trim();
    } catch {
      // invalid JSON, don't send
    }
  }

  return {
    sortDirection: filters.sort,
    eventName: filters.event || undefined,
    consumerName: filters.consumer || undefined,
    consumerStatus: filters.status || undefined,
    statusMode: filters.statusMode,
    ageMinMs: ageMinMs ?? undefined,
    ageMaxMs: ageMaxMs ?? undefined,
    readCountMin: readCountMin !== undefined && !isNaN(readCountMin) ? readCountMin : undefined,
    readCountMax: readCountMax !== undefined && !isNaN(readCountMax) ? readCountMax : undefined,
    resolutionMinMs: resolutionMinMs ?? undefined,
    resolutionMaxMs: resolutionMaxMs ?? undefined,
    payloadContains,
  };
}

// --- Components ---

function ConsumerRow({ msg }: { msg: QueueMessage }) {
  const [open, setOpen] = useState(false);
  const status = msg.message.status ?? "pending";

  return (
    <div className="border rounded bg-muted/30">
      <button
        type="button"
        className="flex items-center justify-between gap-3 p-3 w-full text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <StatusDot status={status} />
          <span className="text-xs font-medium truncate">{msg.message.consumer_name}</span>
          <span className="text-xs text-muted-foreground">
            msg #{String(msg.msg_id)} · {msg.read_ct} read{msg.read_ct !== 1 ? "s" : ""} · vt{" "}
            {new Date(msg.vt).toLocaleTimeString()}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{formatAge(msg.enqueued_at)}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>
      {open && (
        <div className="border-t px-3 py-2 space-y-2">
          <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
            <div>
              <span className="font-medium">msg_id:</span> {String(msg.msg_id)}
            </div>
            <div>
              <span className="font-medium">read_ct:</span> {msg.read_ct}
            </div>
            <div>
              <span className="font-medium">enqueued:</span>{" "}
              {new Date(msg.enqueued_at).toLocaleString()}
            </div>
            <div>
              <span className="font-medium">vt:</span> {new Date(msg.vt).toLocaleString()}
            </div>
          </div>
          {msg.message.processing_results.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Processing Results
              </div>
              <SerializedObjectCodeBlock data={msg.message.processing_results} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CausedByBadge({
  context,
}: {
  context?: { causedBy?: { eventId: number; consumerName: string; jobId: number | string } };
}) {
  if (!context?.causedBy) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-muted rounded px-1.5 py-0.5 text-muted-foreground">
      <ArrowRight className="h-3 w-3" />
      from event #{context.causedBy.eventId} via {context.causedBy.consumerName}
    </span>
  );
}

/** Clickable payload fields that open the related-events timeline */
function ClickablePayload({
  payload,
  onRelated,
}: {
  payload: Record<string, unknown>;
  onRelated: (key: string, value: string) => void;
}) {
  return (
    <div className="text-xs font-mono bg-muted/50 rounded p-2 space-y-0.5">
      {Object.entries(payload).map(([key, val]) => {
        const strVal = typeof val === "string" ? val : JSON.stringify(val);
        const isClickable = typeof val === "string" && val.length > 0;
        return (
          <div key={key} className="flex items-start gap-1">
            <span className="text-muted-foreground">{key}:</span>
            {isClickable ? (
              <button
                type="button"
                className="text-left underline decoration-dotted underline-offset-2 hover:text-foreground text-muted-foreground transition-colors inline-flex items-center gap-0.5"
                onClick={() => onRelated(key, val)}
                title={`Show all events where ${key}=${val}`}
              >
                {strVal}
                <Link2 className="h-3 w-3 shrink-0 opacity-50" />
              </button>
            ) : (
              <span className="text-muted-foreground break-all">{strVal}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EventCard({
  event,
  onRelated,
}: {
  event: EventWithConsumers;
  onRelated: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border rounded-lg bg-card">
      <button
        type="button"
        className="flex items-start justify-between gap-4 p-4 w-full text-left"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <StatusDot status={event.aggregateStatus} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{event.name}</span>
              <CausedByBadge context={event.context} />
            </div>
            <div className="text-xs text-muted-foreground">
              #{event.id} · {event.consumers.length} consumer
              {event.consumers.length !== 1 ? "s" : ""} · {formatAge(event.createdAt)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">Payload</div>
            <ClickablePayload payload={event.payload} onRelated={onRelated} />
          </div>
          {event.context?.causedBy && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Context</div>
              <SerializedObjectCodeBlock data={event.context} />
            </div>
          )}
          {event.consumers.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Consumers</div>
              <div className="space-y-2">
                {event.consumers.map((msg) => (
                  <ConsumerRow key={String(msg.msg_id)} msg={msg} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterBar({
  draft,
  onChange,
  onApply,
  eventNames,
  consumerNames,
}: {
  draft: Filters;
  onChange: (f: Filters) => void;
  onApply: () => void;
  eventNames: string[];
  consumerNames: string[];
}) {
  const hasFilters = Object.entries(draft).some(
    ([key, val]) => val !== DEFAULT_FILTERS[key as keyof Filters],
  );

  return (
    <div className="space-y-3 border rounded-lg p-4 bg-muted/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Filters</span>
        </div>
        <div className="flex items-center gap-2">
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange(DEFAULT_FILTERS);
                // Auto-apply on clear
                setTimeout(onApply, 0);
              }}
              className="h-7 text-xs"
            >
              <X className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
          <Button variant="default" size="sm" onClick={onApply} className="h-7 text-xs">
            Apply
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {/* Sort */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Sort</label>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start text-xs"
            onClick={() =>
              onChange({
                ...draft,
                sort: draft.sort === "desc" ? "asc" : "desc",
              })
            }
          >
            <ArrowUpDown className="h-3 w-3 mr-1.5" />
            {draft.sort === "desc" ? "Newest first" : "Oldest first"}
          </Button>
        </div>

        {/* Event name */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Event</label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background"
            value={draft.event ?? ""}
            onChange={(e) => onChange({ ...draft, event: e.target.value || undefined })}
          >
            <option value="">All events</option>
            {eventNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Consumer name */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Consumer</label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background"
            value={draft.consumer ?? ""}
            onChange={(e) => onChange({ ...draft, consumer: e.target.value || undefined })}
          >
            <option value="">All consumers</option>
            {consumerNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Consumer status */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            Status (
            <button
              type="button"
              className="underline"
              onClick={() =>
                onChange({ ...draft, statusMode: draft.statusMode === "some" ? "all" : "some" })
              }
            >
              {draft.statusMode}
            </button>
            )
          </label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background"
            value={draft.status ?? ""}
            onChange={(e) =>
              onChange({
                ...draft,
                status: (e.target.value || undefined) as ConsumerStatus | undefined,
              })
            }
          >
            <option value="">Any status</option>
            <option value="pending">Pending</option>
            <option value="success">Success</option>
            <option value="retrying">Retrying</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        {/* Age range */}
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Age</label>
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 text-xs flex-1"
              placeholder="min e.g. 5m"
              value={draft.ageMin ?? ""}
              onChange={(e) => onChange({ ...draft, ageMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              placeholder="max e.g. 2d"
              value={draft.ageMax ?? ""}
              onChange={(e) => onChange({ ...draft, ageMax: e.target.value || undefined })}
            />
          </div>
        </div>

        {/* Read count range */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Read count</label>
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 text-xs flex-1"
              type="number"
              min={0}
              placeholder="min"
              value={draft.readMin ?? ""}
              onChange={(e) => onChange({ ...draft, readMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              type="number"
              min={0}
              placeholder="max"
              value={draft.readMax ?? ""}
              onChange={(e) => onChange({ ...draft, readMax: e.target.value || undefined })}
            />
          </div>
        </div>

        {/* Resolution time range */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Resolution time</label>
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 text-xs flex-1"
              placeholder="min"
              value={draft.resMin ?? ""}
              onChange={(e) => onChange({ ...draft, resMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              placeholder="max"
              value={draft.resMax ?? ""}
              onChange={(e) => onChange({ ...draft, resMax: e.target.value || undefined })}
            />
          </div>
        </div>

        {/* Payload JSON filter */}
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">
            Payload contains (JSON, uses @&gt;)
          </label>
          <Input
            className="h-8 text-xs font-mono"
            placeholder='{"machineId": "..."}'
            value={draft.payload ?? ""}
            onChange={(e) => onChange({ ...draft, payload: e.target.value || undefined })}
          />
        </div>
      </div>
    </div>
  );
}

// --- Related Events Timeline (Sheet) ---

function TimelineSheet({
  relatedKey,
  relatedValue,
  onClose,
}: {
  relatedKey: string;
  relatedValue: string;
  onClose: () => void;
}) {
  const { data, isFetching } = useQuery(
    trpc.admin.outbox.relatedEvents.queryOptions({ key: relatedKey, value: relatedValue }),
  );

  // Build a lookup so we can show causal arrows
  const eventIds = useMemo(() => new Set((data ?? []).map((e) => e.id)), [data]);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-sm font-medium">
            Events for {relatedKey}={relatedValue}
          </SheetTitle>
        </SheetHeader>
        <div className={cn("space-y-0 mt-4", isFetching && "opacity-60")}>
          {!data ? (
            <div className="text-sm text-muted-foreground p-4">Loading...</div>
          ) : data.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4">No events found</div>
          ) : (
            data.map((event, idx) => {
              const consumers = (event.consumers ?? []) as QueueMessage[];
              const status = aggregateStatus(consumers);
              const context = event.context as EventWithConsumers["context"];
              const indent =
                context?.causedBy && eventIds.has(context.causedBy.eventId) ? "ml-4" : "";

              return (
                <div key={event.id} className={cn("relative", indent)}>
                  {/* Timeline connector */}
                  {idx > 0 && <div className="absolute left-[11px] -top-2 h-2 w-px bg-border" />}
                  {idx < data.length - 1 && (
                    <div className="absolute left-[11px] bottom-0 top-[22px] w-px bg-border" />
                  )}

                  <div className="flex gap-3 py-2">
                    <div className="relative z-10 mt-0.5">
                      <StatusDot status={status} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{event.name}</span>
                        <span className="text-xs text-muted-foreground">#{event.id}</span>
                        {context?.causedBy && (
                          <span className="text-xs text-muted-foreground">
                            &larr; #{context.causedBy.eventId} / {context.causedBy.consumerName}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString()}
                      </div>
                      {consumers.length > 0 && (
                        <div className="space-y-1 mt-1">
                          {consumers.map((c) => (
                            <div key={String(c.msg_id)} className="flex items-center gap-2 text-xs">
                              <StatusDot status={c.message.status ?? "pending"} />
                              <span className="font-medium">{c.message.consumer_name}</span>
                              <span className="text-muted-foreground">
                                msg #{String(c.msg_id)} · {c.read_ct} read
                                {c.read_ct !== 1 ? "s" : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// --- Page ---

function OutboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = useSearch({ from: "/_auth/admin/outbox" });
  const page = filters.page ?? 0;
  const pageSize = 25;

  // Draft filters — edited locally, only applied on "Apply" click
  const [draft, setDraft] = useState<Filters>(filters);

  const setFilters = (newFilters: Filters) => {
    navigate({ search: newFilters, replace: true });
  };

  const applyFilters = () => {
    setFilters({ ...draft, page: 0 });
  };

  const serverInput = useMemo(
    () => ({
      ...filtersToInput(filters),
      limit: pageSize,
      offset: page * pageSize,
    }),
    [filters, page],
  );

  const { data, isFetching } = useQuery({
    ...trpc.admin.outbox.listEvents.queryOptions(serverInput),
    placeholderData: (prev) => prev,
  });

  const processQueue = useMutation({
    mutationFn: () => trpcClient.admin.outbox.process.mutate(),
    onSuccess: (result) => {
      toast.success(result);
      invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.admin.outbox.listEvents.queryOptions().queryKey,
    });
  };

  const enrichedEvents: EventWithConsumers[] = useMemo(() => {
    if (!data) return [];
    return data.events.map((event) => {
      const consumers = (event.consumers ?? []) as QueueMessage[];
      return {
        id: event.id,
        name: event.name,
        payload: event.payload,
        context: event.context as EventWithConsumers["context"],
        createdAt: new Date(event.createdAt),
        updatedAt: new Date(event.updatedAt),
        consumers,
        aggregateStatus: aggregateStatus(consumers),
      };
    });
  }, [data]);

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Related-events timeline state
  const relatedKey = filters.relatedKey;
  const relatedValue = filters.relatedValue;
  const showTimeline = !!relatedKey && !!relatedValue;

  const openTimeline = (key: string, value: string) => {
    setFilters({ ...filters, relatedKey: key, relatedValue: value });
  };

  const closeTimeline = () => {
    setFilters({ ...filters, relatedKey: undefined, relatedValue: undefined });
  };

  return (
    <div className={cn("p-4 space-y-4 max-w-4xl", isFetching && "opacity-60")}>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Outbox</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={invalidateAll}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => processQueue.mutate()}
            disabled={processQueue.isPending}
          >
            <Play className="h-3.5 w-3.5 mr-1.5" />
            Process Queue
          </Button>
        </div>
      </div>

      <FilterBar
        draft={draft}
        onChange={setDraft}
        onApply={applyFilters}
        eventNames={data?.eventNames ?? []}
        consumerNames={data?.consumerNames ?? []}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {total} event{total !== 1 ? "s" : ""}
          </span>
          {totalPages > 1 && (
            <>
              <span>·</span>
              <span>
                page {page + 1} of {totalPages}
              </span>
            </>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page === 0}
              onClick={() => setFilters({ ...filters, page: page - 1 })}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={page >= totalPages - 1}
              onClick={() => setFilters({ ...filters, page: page + 1 })}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {enrichedEvents.length === 0 ? (
        <div className="text-sm text-muted-foreground border rounded-lg p-8 text-center">
          {data ? "No events match the current filters" : "Loading..."}
        </div>
      ) : (
        <div className="space-y-2">
          {enrichedEvents.map((event) => (
            <EventCard key={event.id} event={event} onRelated={openTimeline} />
          ))}
        </div>
      )}

      {showTimeline && (
        <TimelineSheet
          relatedKey={relatedKey}
          relatedValue={relatedValue}
          onClose={closeTimeline}
        />
      )}
    </div>
  );
}
