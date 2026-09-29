// A project's docs: the files in its repos, markdown first among them. The app names a repo by its name, the part
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

/** The repo's files as Docs lists them: every one, sorted (lib/file-kind.ts says what each opens as). */
export function repoFiles(paths: string[]) {
  return paths.toSorted();
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
