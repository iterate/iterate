import "@scalar/api-reference-react/style.css";
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import { BookOpenText } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@iterate-com/ui/components/empty";
import {
  fetchLandingData,
  getDocsSourceForRoute,
  getRouteBySlug,
  type LandingDataResponse,
} from "@/lib/landing.ts";

export const Route = createFileRoute("/_app/routes/$slug/docs")({
  ssr: false,
  component: ServiceDocsPage,
});

function tagName(tag: unknown) {
  if (typeof tag === "string") return tag;
  if (tag && typeof tag === "object" && "name" in tag && typeof tag.name === "string") {
    return tag.name;
  }
  return "";
}

function ServiceDocsPage() {
  const { slug } = Route.useParams();
  const { data, isPending } = useQuery<LandingDataResponse>({
    queryKey: ["registry", "landing"],
    queryFn: fetchLandingData,
  });

  const route = getRouteBySlug(data, slug);
  const source = route ? getDocsSourceForRoute(data, route) : undefined;
  const configuration = useMemo(():
    | Parameters<typeof ApiReferenceReact>[0]["configuration"]
    | null => {
    if (!source) return null;
    return {
      title: `${route?.title ?? route?.host ?? "Service"} API Docs`,
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
      url: source.specUrl,
    };
  }, [route, source]);

  return (
    <div className="-m-4 flex min-h-[calc(100vh-2rem)] flex-col overflow-hidden bg-background">
      {isPending ? <p className="m-4 text-sm text-muted-foreground">Loading docs...</p> : null}

      {!isPending && !source ? (
        <Empty className="m-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpenText className="size-5" />
            </EmptyMedia>
            <EmptyTitle>No docs for this service</EmptyTitle>
            <EmptyDescription>
              `{slug}` does not expose an OpenAPI source through the registry.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {configuration ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ApiReferenceReact configuration={configuration} />
        </div>
      ) : null}
    </div>
  );
}
