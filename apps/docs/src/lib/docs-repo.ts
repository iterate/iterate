// A project's docs: the markdown files in its repos. The app names a repo by its name, the part
// after `/repos/` (`config` is /repos/config), in its URLs and its repo picker.

/** The repo called `name`. */
export const repoPath = (name: string) => `/repos/${name}`;

/** The names of the repos the picker offers, sorted: every `/repos/<name>` of the project. */
export function repoNames(repos: { path: string }[]) {
  return repos
    .map((repo) => /^\/repos\/([^/]+)$/.exec(repo.path)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

/** The repo's paths that are docs, sorted: every `.md` file. */
export function docPaths(paths: string[]) {
  return paths.filter((path) => path.endsWith(".md")).sort();
}

/** The path a new doc called `title` gets: its words, lowercased and dashed, `.md` on (once: a
 *  title "plan.md" is plan.md), each `/` a folder ("Offsites/Lisbon" is offsites/lisbon.md). ""
 *  when the title has no letters or digits. */
export function newDocPath(title: string) {
  const segments = title
    .replace(/\.md$/i, "")
    .split("/")
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean);
  return segments.length > 0 ? `${segments.join("/")}.md` : "";
}

/** The first heading a new doc called `title` gets: its last part ("Offsites/Lisbon" → "Lisbon"). */
export function newDocHeading(title: string) {
  return title.split("/").at(-1)!.trim();
}

/** A folder of docs as the sidebar shows it: its name and path ("" for the top), its subfolders,
 *  then its docs' paths, both sorted. */
export type DocFolder = { name: string; path: string; folders: DocFolder[]; docs: string[] };

/** Docs' paths as folders, from their `/`s. */
export function docTree(paths: string[]): DocFolder {
  type Building = { folders: Map<string, Building>; docs: string[] };
  const root: Building = { folders: new Map(), docs: [] };
  for (const path of paths) {
    let at = root;
    for (const name of path.split("/").slice(0, -1)) {
      if (!at.folders.has(name)) at.folders.set(name, { folders: new Map(), docs: [] });
      at = at.folders.get(name)!;
    }
    at.docs.push(path);
  }
  const sorted = (name: string, path: string, at: Building): DocFolder => ({
    name,
    path,
    folders: [...at.folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sub, folder]) => sorted(sub, path ? `${path}/${sub}` : sub, folder)),
    docs: at.docs.toSorted(),
  });
  return sorted("", "", root);
}
