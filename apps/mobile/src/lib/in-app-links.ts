// Same-deployment links in agent chat replies should open the rich in-app
// screen, not the system browser: an agent answering "here's your ticket"
// with <base-url>/media/<hash>-ticket.png should land on the Media screen
// with that item found, and /repos/... should open the repo workspace. Pure
// resolver — the Markdown component's onLinkPress consults it and falls
// through to Linking.openURL for everything else. Add rows to SPECIAL_PATHS
// as more streams grow in-app lenses.

export type InAppLink =
  | { pathname: "/project/[projectId]/media"; params: { projectId: string; q?: string } }
  | { pathname: "/project/[projectId]/repo"; params: { projectId: string; repoPath: string } }
  | { pathname: "/project/[projectId]/repos"; params: { projectId: string } }
  | { pathname: "/project/[projectId]/integrations"; params: { projectId: string } };

const SPECIAL_PATHS: {
  prefix: string;
  resolve: (path: string, projectId: string) => InAppLink;
}[] = [
  {
    prefix: "/media",
    resolve: (path, projectId) => {
      // A media file's path is /media/<sha256>-<original-filename>; search
      // by the original filename part, which uniquely finds the item.
      const last = path.slice("/media".length).split("/").at(-1) || "";
      const filename = last.replace(/^[0-9a-f]{32,}-/, "");
      return {
        pathname: "/project/[projectId]/media",
        params: { projectId, ...(filename && { q: filename }) },
      };
    },
  },
  {
    prefix: "/integrations",
    resolve: (_path, projectId) => ({
      pathname: "/project/[projectId]/integrations",
      params: { projectId },
    }),
  },
  {
    prefix: "/repos",
    resolve: (path, projectId): InAppLink => {
      // Repo paths are /repos/<name>[/file...]; the repo screen owns file
      // selection, so route to the repo itself. Bare /repos is the list.
      const repoPath = path.split("/").slice(0, 3).join("/");
      if (repoPath === "/repos") {
        return { pathname: "/project/[projectId]/repos", params: { projectId } };
      }
      return { pathname: "/project/[projectId]/repo", params: { projectId, repoPath } };
    },
  },
];

/**
 * The in-app destination for `url`, or null when it should open in the
 * system browser. Only same-origin links resolve — a lookalike host must
 * never hijack navigation.
 */
export function resolveInAppLink(
  url: string,
  context: { baseUrl: string | undefined; projectId: string | undefined },
): InAppLink | null {
  if (!context.baseUrl || !context.projectId) return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(context.baseUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== base.origin) return null;
  const entry = SPECIAL_PATHS.find(
    ({ prefix }) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
  );
  if (!entry) return null;
  return entry.resolve(parsed.pathname, context.projectId);
}
