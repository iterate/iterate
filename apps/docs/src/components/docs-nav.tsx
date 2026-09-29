// The sidebar's docs: which repo, "New doc", then every doc in the repo as a tree, folders from
// their paths' `/`s, the open doc highlighted and its folders open. ⌘K (the shell's palette) lists what
// the sidebar shows, so it finds a doc by name: a folder is a <details>, whose closed rows stay in
// the page for it to read, and a doc in a folder carries the folder, hidden, as its second text,
// which the palette shows after its name.
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronRight, FileText, Folder, Plus } from "lucide-react";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/sidebar";
import { useDocList } from "../lib/doc-list.ts";
import { docTree, type DocFolder } from "../lib/docs-repo.ts";

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
  const { docs } = useDocList();
  const navigate = useNavigate();
  // the open doc's path, when a doc is open (the doc route's splat)
  const open = useParams({ strict: false })._splat;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Docs</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-1">
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
          {docs.kind === "loaded" ? (
            <FolderRows folder={docTree(docs.paths)} slug={slug} repo={repo} open={open} top />
          ) : (
            <li
              className={
                docs.kind === "failed"
                  ? "px-2 py-1 text-xs text-destructive"
                  : "px-2 py-1 text-xs text-muted-foreground"
              }
            >
              {docs.kind === "failed" ? `Couldn't list the docs: ${docs.message}` : "Loading docs…"}
            </li>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** A folder's subfolders, then its docs: the sidebar's top-level rows (`top`), or a folder's
 *  nested ones. */
function FolderRows({
  folder,
  slug,
  repo,
  open,
  top,
}: {
  folder: DocFolder;
  slug: string;
  repo: string;
  open: string | undefined;
  top: boolean;
}) {
  const Item = top ? SidebarMenuItem : SidebarMenuSubItem;
  return (
    <>
      {folder.folders.map((sub) => (
        <Item key={sub.path}>
          {/* open when it holds the open doc; after that the reader's own clicks decide */}
          <details className="group/folder" open={Boolean(open?.startsWith(`${sub.path}/`))}>
            <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden [&::-webkit-details-marker]:hidden [&>svg]:size-4 [&>svg]:shrink-0">
              <ChevronRight className="transition-transform group-open/folder:rotate-90" />
              <Folder />
              <span className="truncate">{sub.name}</span>
            </summary>
            <SidebarMenuSub>
              <FolderRows folder={sub} slug={slug} repo={repo} open={open} top={false} />
            </SidebarMenuSub>
          </details>
        </Item>
      ))}
      {folder.docs.map((path) => {
        const link = <Link to="/projects/$slug/$repo/$" params={{ slug, repo, _splat: path }} />;
        const name = path.split("/").at(-1)!.replace(/\.md$/, "");
        return top ? (
          <SidebarMenuItem key={path}>
            <SidebarMenuButton render={link} isActive={path === open} tooltip={name}>
              <FileText />
              <span>{name}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <SidebarMenuSubItem key={path}>
            <SidebarMenuSubButton render={link} isActive={path === open}>
              <span>{name}</span>
              {/* what ⌘K shows after the name */}
              <span hidden>{folder.path}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </>
  );
}
