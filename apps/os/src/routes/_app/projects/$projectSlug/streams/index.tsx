import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@iterate-com/ui/components/empty";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Button } from "@iterate-com/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@iterate-com/ui/components/combobox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { toast } from "@iterate-com/ui/components/sonner";
import { StreamDebugLink } from "~/components/stream-debug-link.tsx";
import { projectStreamsListQueryOptions } from "~/lib/project-route-query.ts";
import { streamPathFromInput } from "~/lib/stream-links.ts";
import { orpc } from "~/orpc/client.ts";

export const Route = createFileRoute("/_app/projects/$projectSlug/streams/")({
  loader: async ({ context }) => {
    const { project } = context;
    await context.queryClient.ensureQueryData(projectStreamsListQueryOptions(project.id));

    return {
      breadcrumb: "All",
      project,
    };
  },
  component: ProjectStreamsIndexPage,
});

type SortKey = "streamPath" | "createdAt" | "lastWokenAt";
type SortDirection = "asc" | "desc";

function ProjectStreamsIndexPage() {
  const params = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = Route.useLoaderData();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "lastWokenAt",
    direction: "desc",
  });
  const streamsQueryOptions = projectStreamsListQueryOptions(project.id);
  const { data } = useQuery(streamsQueryOptions);
  const createStream = useMutation(
    orpc.project.streams.create.mutationOptions({
      onSuccess: async (_state, input) => {
        await queryClient.invalidateQueries({ queryKey: streamsQueryOptions.queryKey });
        setFilter("");
        void navigate({
          to: "/projects/$projectSlug/streams/$",
          params: {
            projectSlug: params.projectSlug,
            // The route's params.stringify converts StreamPath -> splat; passing
            // a pre-splatted string here would get sliced a second time.
            _splat: input.streamPath,
          },
        });
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : "Could not create stream.");
      },
    }),
  );
  const streams = useMemo(() => data?.streams ?? [], [data?.streams]);
  const streamPaths = useMemo(() => streams.map((stream) => stream.streamPath), [streams]);
  const visibleStreams = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return streams
      .filter((stream) => {
        if (!query) return true;
        return (
          stream.streamPath.toLowerCase().includes(query) ||
          stream.name.toLowerCase().includes(query)
        );
      })
      .toSorted((left, right) => {
        const direction = sort.direction === "asc" ? 1 : -1;
        return direction * compareStreamRows(left, right, sort.key);
      });
  }, [filter, sort, streams]);

  function submitCreateStream() {
    try {
      createStream.mutate({
        projectSlugOrId: project.id,
        streamPath: streamPathFromInput(filter),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Stream path is invalid.");
    }
  }

  return (
    <section className="w-full space-y-4 p-4">
      <div className="flex justify-end">
        <StreamDebugLink label="Open root stream" projectSlug={project.slug} streamPath="/" />
      </div>
      <form
        className="flex w-full flex-col gap-2 md:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreateStream();
        }}
      >
        <Combobox<string>
          items={streamPaths}
          inputValue={filter}
          onInputValueChange={(value) => setFilter(value)}
          onValueChange={(value) => {
            if (value) setFilter(value);
          }}
        >
          <ComboboxInput
            className="h-9 flex-1"
            placeholder="Filter or create stream path..."
            showClear
            showTrigger={streamPaths.length > 0}
          />
          <ComboboxContent>
            <ComboboxEmpty>No streams match.</ComboboxEmpty>
            <ComboboxList>
              {streamPaths.map((path) => (
                <ComboboxItem key={path} value={path}>
                  <EventsStreamPathLabel path={path} className="min-w-0" />
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <div className="flex gap-2 md:shrink-0">
          <Button
            type="button"
            variant="outline"
            className="flex-1 md:flex-none"
            onClick={() => setFilter("")}
          >
            Reset
          </Button>
          <Button type="submit" className="flex-1 md:flex-none" disabled={createStream.isPending}>
            {createStream.isPending ? "Creating..." : "Create stream"}
          </Button>
        </div>
      </form>

      {streams.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No streams</EmptyTitle>
            <EmptyDescription>Initialized project streams will appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  active={sort.key === "streamPath"}
                  direction={sort.direction}
                  label="Stream path"
                  onClick={() => setSort(nextSort(sort, "streamPath"))}
                />
                <SortableHead
                  active={sort.key === "createdAt"}
                  direction={sort.direction}
                  label="Created"
                  onClick={() => setSort(nextSort(sort, "createdAt"))}
                />
                <SortableHead
                  active={sort.key === "lastWokenAt"}
                  direction={sort.direction}
                  label="Woke"
                  onClick={() => setSort(nextSort(sort, "lastWokenAt"))}
                />
                <TableHead className="w-28 text-right">Events</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleStreams.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No streams match.
                  </TableCell>
                </TableRow>
              ) : (
                visibleStreams.map((stream) => (
                  <TableRow key={stream.name}>
                    <TableCell className="py-3">
                      <Link
                        className="block min-w-0 rounded-sm text-sm font-medium hover:underline"
                        to="/projects/$projectSlug/streams/$"
                        params={{
                          projectSlug: params.projectSlug,
                          _splat: stream.streamPath,
                        }}
                      >
                        <EventsStreamPathLabel path={stream.streamPath} className="min-w-0" />
                      </Link>
                    </TableCell>
                    <TableCell className="w-40 text-muted-foreground">
                      {formatRelativeTime(stream.createdAt)}
                    </TableCell>
                    <TableCell className="w-40 text-muted-foreground">
                      {formatRelativeTime(stream.lastWokenAt)}
                    </TableCell>
                    <TableCell className="w-28 text-right">
                      <StreamDebugLink
                        label="Open"
                        projectSlug={project.slug}
                        streamPath={stream.streamPath}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function SortableHead(input: {
  active: boolean;
  direction: SortDirection;
  label: string;
  onClick: () => void;
}) {
  return (
    <TableHead>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 h-8 px-2"
        onClick={input.onClick}
      >
        {input.label}
        <span className="text-[10px] text-muted-foreground">
          {input.active ? input.direction : "sort"}
        </span>
      </Button>
    </TableHead>
  );
}

function nextSort(current: { key: SortKey; direction: SortDirection }, key: SortKey) {
  if (current.key !== key) return { key, direction: "asc" as const };
  return { key, direction: current.direction === "asc" ? ("desc" as const) : ("asc" as const) };
}

function compareStreamRows(
  left: { streamPath: string; createdAt: string; lastWokenAt: string },
  right: { streamPath: string; createdAt: string; lastWokenAt: string },
  key: SortKey,
) {
  if (key === "streamPath") return left.streamPath.localeCompare(right.streamPath);
  return new Date(left[key]).getTime() - new Date(right[key]).getTime();
}

function formatRelativeTime(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const units = [
    { label: "year", seconds: 31_536_000 },
    { label: "month", seconds: 2_592_000 },
    { label: "day", seconds: 86_400 },
    { label: "hour", seconds: 3_600 },
    { label: "minute", seconds: 60 },
  ] as const;
  const unit = units.find((unit) => absoluteSeconds >= unit.seconds);
  if (!unit) return seconds < 0 ? "in a few seconds" : "just now";

  const count = Math.round(absoluteSeconds / unit.seconds);
  const suffix = count === 1 ? unit.label : `${unit.label}s`;
  return seconds < 0 ? `in ${count} ${suffix}` : `${count} ${suffix} ago`;
}
