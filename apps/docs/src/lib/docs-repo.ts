// The docs of a project: markdown files in one repo of their own, `/repos/docs`. Not the config
// repo, where a commit republishes the project's site (tasks/docs-app.md).
export const DOCS_REPO = "/repos/docs";

/** The repo's paths that are docs, sorted: every `.md` file. */
export function docPaths(paths: string[]) {
  return paths.filter((path) => path.endsWith(".md")).sort();
}

/** The path a new doc called `title` gets: its words, lowercased and dashed, `.md` on (once: a
 *  title "plan.md" is plan.md). "" when the title has no letters or digits. */
export function newDocPath(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}.md` : "";
}
