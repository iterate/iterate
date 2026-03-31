import "@scalar/api-reference-react/style.css";
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";

interface DocsSourcesResponse {
  sources: Array<{
    id: string;
    title: string;
    specUrl: string;
    appUrl: string;
  }>;
  total: number;
}

export const Route = createFileRoute("/_app/docs")({
  ssr: false,
  staticData: {
    breadcrumb: "Docs",
  },
  component: DocsPage,
});

function tagName(tag: unknown) {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object" && "name" in tag && typeof tag.name === "string") {
    return tag.name;
  }
  return "";
}

function DocsPage() {
  const { data, isPending } = useQuery<DocsSourcesResponse>({
    queryKey: ["registry", "docs", "sources"],
    queryFn: async () => {
      const response = await fetch("/api/docs/sources");
      if (!response.ok) {
        throw new Error(`Failed to load docs sources (${response.status})`);
      }
      return (await response.json()) as DocsSourcesResponse;
    },
  });
  const orderedSources = useMemo(
    () =>
      [...(data?.sources ?? [])].sort((a, b) => {
        if (a.id === "registry" && b.id !== "registry") return -1;
        if (a.id !== "registry" && b.id === "registry") return 1;
        return a.title.localeCompare(b.title);
      }),
    [data?.sources],
  );
  const configuration = useMemo(
    (): Parameters<typeof ApiReferenceReact>[0]["configuration"] => ({
      title: "Daemon V2 API Docs",
      layout: "modern",
      defaultOpenAllTags: true,
      operationTitleSource: "summary" as const,
      operationsSorter: "method" as const,
      documentDownloadType: "direct" as const,
      telemetry: false,
      defaultHttpClient: {
        targetKey: "shell" as const,
        clientKey: "curl" as const,
      },
      tagsSorter: (a: unknown, b: unknown) => {
        const aName = tagName(a).toLowerCase();
        const bName = tagName(b).toLowerCase();
        return aName.localeCompare(bName);
      },
      sources: orderedSources.map((source, index) => ({
        title: source.title,
        url: source.specUrl,
        default: source.id === "registry" || index === 0,
      })),
    }),
    [orderedSources],
  );

  return (
    <div className="-m-4 flex min-h-[calc(100vh-2rem)] flex-col overflow-hidden bg-background">
      {isPending ? (
        <p className="m-4 text-sm text-muted-foreground">Loading docs sources...</p>
      ) : null}

      {orderedSources.length === 0 && !isPending ? (
        <Empty className="m-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenText className="size-5" />
            </EmptyMedia>
            <EmptyTitle>No docs sources</EmptyTitle>
            <EmptyDescription>
              Tag a route with `openapi` and an `openapiPath` metadata value.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {orderedSources.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ApiReferenceReact configuration={configuration} />
        </div>
      ) : null}
    </div>
  );
}
