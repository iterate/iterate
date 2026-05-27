import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { Button } from "@iterate-com/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@iterate-com/ui/components/collapsible";
import { z } from "zod";
import { ExistingCodemodeSessionControls } from "~/components/codemode-session-controls.tsx";
import { ProjectStreamView } from "~/components/project-stream-view.tsx";
import { orpc } from "~/orpc/client.ts";

const Search = z.object({
  streamPath: StreamPath.optional(),
});

export const Route = createFileRoute(
  "/_app/projects/$projectSlug/codemode-sessions/$codemodeSessionName",
)({
  params: {
    parse: (raw) => ({
      codemodeSessionName: safeDecodeBase64Url(raw.codemodeSessionName),
    }),
    stringify: (parsed) => ({
      codemodeSessionName: encodeBase64Url(parsed.codemodeSessionName),
    }),
  },
  validateSearch: Search,
  ssr: false,
  loader: async ({ context, location, params }) => {
    const search = Search.parse(location.search);
    const project = await context.queryClient.ensureQueryData({
      ...orpc.projects.findBySlug.queryOptions({ input: { slug: params.projectSlug } }),
      staleTime: 30_000,
    });

    try {
      const session = await context.queryClient.ensureQueryData({
        ...orpc.project.codemode.findSession.queryOptions({
          input: { name: params.codemodeSessionName, projectSlugOrId: project.id },
        }),
        staleTime: 10_000,
      });

      return {
        breadcrumb: "Session",
        session,
      };
    } catch (error) {
      if (!search.streamPath) throw error;
      if (search.streamPath.startsWith("/projects/")) throw error;

      return {
        breadcrumb: "Session",
        session: {
          name: params.codemodeSessionName,
          projectId: project.id,
          streamPath: search.streamPath,
          createdAt: new Date().toISOString(),
          lastWokenAt: new Date().toISOString(),
        },
      };
    }
  },
  component: CodemodeSessionPage,
});

function CodemodeSessionPage() {
  const { session } = Route.useLoaderData();
  const params = Route.useParams();

  return (
    <ProjectStreamView
      emptyLabel="No events in this codemode session yet"
      headerAccessory={
        <Collapsible defaultOpen={false}>
          <div className="flex items-center justify-end gap-2 p-4">
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm">
                  <ChevronRight className="size-4 transition-transform [[data-panel-open]_&]:rotate-90" />
                  Append event
                </Button>
              }
            />
          </div>
          <CollapsibleContent>
            <div className="w-full max-w-7xl space-y-4 px-4 pb-4">
              <ExistingCodemodeSessionControls
                projectId={session.projectId}
                streamPath={session.streamPath}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      }
      projectSlug={params.projectSlug}
      projectSlugOrId={session.projectId}
      streamPath={session.streamPath}
    />
  );
}

function encodeBase64Url(value: string): string {
  return btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(base64)));
}

/** Decode base64url, falling back to the raw value for old-style URLs. */
function safeDecodeBase64Url(value: string): string {
  try {
    return decodeBase64Url(value);
  } catch {
    return value;
  }
}
