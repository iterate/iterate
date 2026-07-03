import { readFile } from "node:fs/promises";

import { getOctokit, getRepo } from "./github.ts";
import { isMainModule } from "./main-module.ts";

export async function createRelease() {
  const releaseName = process.env.RELEASE_NAME;
  const releaseTitle = process.env.RELEASE_TITLE;
  if (!releaseName) throw new Error("RELEASE_NAME is required");
  if (!releaseTitle) throw new Error("RELEASE_TITLE is required");

  await getOctokit().rest.repos.createRelease({
    ...getRepo(),
    tag_name: releaseName,
    name: releaseName,
    body: [releaseTitle, "", await readFile("changelog.md", "utf8")].join("\n"),
  });
}

if (isMainModule(import.meta.url)) {
  await createRelease();
}
