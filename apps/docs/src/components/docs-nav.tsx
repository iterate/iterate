// The sidebar's docs: which repo, "New doc", then every file in the repo as a tree (doc-tree.ts),
// the open file selected and its folders open.
import { useMemo } from "react";
import { Link, useNavigate, useRouteContext, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/ui/native-select";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/ui/sidebar";
import { authorOf } from "../lib/author.ts";
import { createDoc } from "../lib/create-doc.ts";
import { useDocList } from "../lib/doc-list.ts";
import { repoPath } from "../lib/docs-repo.ts";
import { DocTree } from "./doc-tree.ts";

/** The doc route, whose splat is the open file's path. */
const docRoute = "/_auth/projects/$slug/$repo/$";

export function DocsNav({
  slug,
  repo,
  repos,
}: {
  slug: string;
  /** the repo shown, by name */
  repo: string;
  /** the project's repos, by name; undefined while they're read */
  repos: string[] | undefined;
}) {
  const { list, docs } = useDocList();
  const navigate = useNavigate();
  const router = useRouter();
  const { api, project, info } = useRouteContext({ from: "/_auth/projects/$slug" });
  const tree = useMemo(
    () =>
      new DocTree({
        list,
        openPath: () =>
          router.state.matches.find((match) => match.routeId === docRoute)?.params._splat,
        onNavigated: (listener) => router.subscribe("onResolved", listener),
        open: (path) =>
          void navigate({ to: "/projects/$slug/$repo/$", params: { slug, repo, _splat: path } }),
        create: async (path) => {
          using itx = await api.projects.get(project.id);
          await createDoc({
            project: itx,
            repo: repoPath(repo),
            path,
            heading: path
              .split("/")
              .at(-1)!
              .replace(/\.[^.]+$/, ""),
            author: authorOf(info.principal),
          });
          list.reload();
          await navigate({ to: "/projects/$slug/$repo/$", params: { slug, repo, _splat: path } });
        },
      }),
    [list, router, navigate, slug, repo, api, project.id, info.principal],
  );
  return (
    <SidebarGroup className="min-h-0 flex-1">
      <SidebarGroupLabel>Docs</SidebarGroupLabel>
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-1">
        <NativeSelect
          size="sm"
          aria-label="Repo"
          className="w-full group-data-[collapsible=icon]:hidden"
          value={repo}
          onChange={(event) =>
            void navigate({
              to: "/projects/$slug/$repo",
              params: { slug, repo: event.target.value },
            })
          }
        >
          {/* the repo shown, before the list of them has arrived */}
          {(repos || [repo]).map((name) => (
            <NativeSelectOption key={name} value={name}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/projects/$slug/$repo" params={{ slug, repo }} />}>
              <Plus />
              <span>New doc</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {docs.kind === "loaded" ? (
          <div
            ref={tree.mount}
            aria-label="Files"
            className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden"
          />
        ) : (
          <p
            className={
              docs.kind === "failed"
                ? "px-2 py-1 text-xs text-destructive"
                : "px-2 py-1 text-xs text-muted-foreground"
            }
          >
            {docs.kind === "failed" ? `Couldn't list the files: ${docs.message}` : "Loading files…"}
          </p>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
