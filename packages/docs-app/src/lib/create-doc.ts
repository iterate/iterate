// Making a file in a repo: one commit on the repo's tip as it is now (someone may have made the
// same file since the page last looked, and then it's left as it is). A markdown file starts with
// its name as a heading; anything else starts empty. The New doc box and the tree's "New doc" both
// come here.
import type { AuthenticatedApp } from "iterate/app";
import { fileKind } from "./file-kind.ts";

export async function createDoc(input: {
  project: Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;
  /** `/repos/<name>` */
  repo: string;
  path: string;
  /** the first heading of a markdown file */
  heading: string;
  author: { name: string; email: string } | undefined;
}) {
  using repo = input.project.repos.get(input.repo);
  const { commitOid, paths } = await repo.listFiles();
  if (paths.includes(input.path)) return;
  await repo.commitFiles({
    message: `docs: new ${input.path}`,
    changes: [
      {
        path: input.path,
        content: fileKind(input.path) === "markdown" ? `# ${input.heading}\n` : "",
      },
    ],
    parent: commitOid,
    author: input.author,
  });
}
