// docs/install.ts — how a doc gets co-edited (frames.ts): the Docs app calls `ensureDoc` from the
// browser as a doc opens. It enables the root's docs processor (root.ts), marks the doc opened, lends
// the doc's context the root's repos (a context below `/` reaches only itself; a rule naming
// `builtins` is a session's to write) and enables the doc's processor (processor.ts). Both load from
// a source that pins this package at the app's own build, so a deploy of the app upgrades every doc
// it opens next. Nothing here is the runtime.
import type { IterateContextApi } from "iterate/api";
import {
  COMMIT_NOTICED,
  DOC_LEFT,
  DOC_OPENED,
  docContextPath,
  EDIT_FRAME,
  type DocRef,
} from "./frames.ts";

/** The source the processor loads, by file: `version` is what package.json pins (a pkg.pr.new URL
 *  at a commit, or an npm range once the package is on npm). */
export function docsSource(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ main: "index.ts", dependencies: { "@iterate-com/docs": version } }, null, 2)}\n`,
    "index.ts": 'export { DocDurableObject, DocsDurableObject } from "@iterate-com/docs";\n',
  };
}

const ROOT_REPOS = "itx.builtins.cd('/').repos";

/** The context co-editing `doc` (a repo and a path in it), its processor running at `version`.
 *  Idempotent: an open of a doc already set up at this version writes nothing. */
export async function ensureDoc(
  project: Pick<IterateContextApi, "cd" | "append" | "processors">,
  doc: DocRef,
  version: string,
): Promise<IterateContextApi> {
  await enableAt(project, "docs", version, {
    className: "DocsDurableObject",
    consumes: ["events.iterate.com/repo/commit-completed", DOC_OPENED],
  });
  // one per doc: an open of a doc already opened appends nothing
  const contextPath = docContextPath(doc);
  await project.append({
    type: DOC_OPENED,
    payload: { repo: doc.repo, path: doc.path },
    idempotencyKey: `${DOC_OPENED}:${contextPath}`,
  });
  const context = project.cd(contextPath);
  if ((await context.rewriteRules.get("itx.repos"))?.target !== ROOT_REPOS)
    await context.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.repos", target: ROOT_REPOS },
    });
  await enableAt(context, "doc", version, {
    className: "DocDurableObject",
    consumes: [EDIT_FRAME, COMMIT_NOTICED, DOC_LEFT],
  });
  return context;
}

/** Enable processor `name` at `version` unless it already runs that version there: the version
 *  names the build, so the same version is the same code. */
async function enableAt(
  context: Pick<IterateContextApi, "processors">,
  name: string,
  version: string,
  spec: { className: string; consumes: string[] },
) {
  const rows = await context.processors.list();
  if (rows.find((row) => row.name === name)?.hostedFacet?.cacheKey === version) return;
  await context.processors.enable(name, {
    source: docsSource(version),
    cacheKey: version,
    ...spec,
  });
}
