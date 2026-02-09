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
} from "lucide-react";
import { z } from "zod/v4";
import { ms, parse as msParse } from "ms";
import { toast } from "sonner";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { SerializedObjectCodeBlock } from "../../components/serialized-object-code-block.tsx";
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
    processing_results: unknown[];
    status?: ConsumerStatus;
  };
};

type ConsumerStatus = "pending" | "success" | "retrying" | "failed";

type EventWithConsumers = {
  id: number;
  name: string;
  payload: Record<string, unknown>;
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
            msg #{String(msg.msg_id)} · {msg.read_ct} read{msg.read_ct !== 1 ? "s" : ""}
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
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">Full Message</div>
            <SerializedObjectCodeBlock data={msg.message} />
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

function EventCard({ event }: { event: EventWithConsumers }) {
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
            <div className="font-medium text-sm">{event.name}</div>
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
            <div className="text-xs font-medium text-muted-foreground mb-1">Event Payload</div>
            <SerializedObjectCodeBlock data={event.payload} />
          </div>
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
  filters,
  onChange,
  eventNames,
  consumerNames,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  eventNames: string[];
  consumerNames: string[];
}) {
  const hasFilters = Object.entries(filters).some(
    ([key, val]) => val !== DEFAULT_FILTERS[key as keyof Filters],
  );

  return (
    <div className="space-y-3 border rounded-lg p-4 bg-muted/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Filters</span>
        </div>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(DEFAULT_FILTERS)}
            className="h-7 text-xs"
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
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
                ...filters,
                sort: filters.sort === "desc" ? "asc" : "desc",
              })
            }
          >
            <ArrowUpDown className="h-3 w-3 mr-1.5" />
            {filters.sort === "desc" ? "Newest first" : "Oldest first"}
          </Button>
        </div>

        {/* Event name */}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Event</label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background"
            value={filters.event ?? ""}
            onChange={(e) => onChange({ ...filters, event: e.target.value || undefined })}
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
            value={filters.consumer ?? ""}
            onChange={(e) => onChange({ ...filters, consumer: e.target.value || undefined })}
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
                onChange({ ...filters, statusMode: filters.statusMode === "some" ? "all" : "some" })
              }
            >
              {filters.statusMode}
            </button>
            )
          </label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ring-offset-background"
            value={filters.status ?? ""}
            onChange={(e) =>
              onChange({
                ...filters,
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
              value={filters.ageMin ?? ""}
              onChange={(e) => onChange({ ...filters, ageMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              placeholder="max e.g. 2d"
              value={filters.ageMax ?? ""}
              onChange={(e) => onChange({ ...filters, ageMax: e.target.value || undefined })}
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
              value={filters.readMin ?? ""}
              onChange={(e) => onChange({ ...filters, readMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              type="number"
              min={0}
              placeholder="max"
              value={filters.readMax ?? ""}
              onChange={(e) => onChange({ ...filters, readMax: e.target.value || undefined })}
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
              value={filters.resMin ?? ""}
              onChange={(e) => onChange({ ...filters, resMin: e.target.value || undefined })}
            />
            <span className="text-xs text-muted-foreground">&ndash;</span>
            <Input
              className="h-8 text-xs flex-1"
              placeholder="max"
              value={filters.resMax ?? ""}
              onChange={(e) => onChange({ ...filters, resMax: e.target.value || undefined })}
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
            value={filters.payload ?? ""}
            onChange={(e) => onChange({ ...filters, payload: e.target.value || undefined })}
          />
        </div>
      </div>
    </div>
  );
}

// --- Page ---

function OutboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = useSearch({ from: "/_auth/admin/outbox" });
  const page = filters.page ?? 0;
  const pageSize = 25;

  const setFilters = (newFilters: Filters) => {
    navigate({ search: newFilters, replace: true });
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
        createdAt: new Date(event.createdAt),
        updatedAt: new Date(event.updatedAt),
        consumers,
        aggregateStatus: aggregateStatus(consumers),
      };
    });
  }, [data]);

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  // Reset page when filters change
  const handleFilterChange = (newFilters: Filters) => {
    setFilters({ ...newFilters, page: 0 });
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
        filters={filters}
        onChange={handleFilterChange}
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
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
