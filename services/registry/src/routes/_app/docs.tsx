import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
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
    serviceUrl: string;
  }>;
  total: number;
}

export const Route = createFileRoute("/_app/docs")({
  ssr: false,
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
  const sources = data?.sources ?? [];
  const orderedSources = useMemo(
    () =>
      [...sources].sort((a, b) => {
        if (a.id === "registry" && b.id !== "registry") return -1;
        if (a.id !== "registry" && b.id === "registry") return 1;
        return a.title.localeCompare(b.title);
      }),
    [sources],
  );
  const configuration = useMemo(
    (): Parameters<typeof ApiReferenceReact>[0]["configuration"] => ({
      title: "Registry API Docs",
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
        const aIsService = aName === "service";
        const bIsService = bName === "service";

        if (aIsService && !bIsService) return 1;
        if (!aIsService && bIsService) return -1;
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
