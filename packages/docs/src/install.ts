// docs/install.ts — how a doc gets co-edited (frames.ts). A project INSTALLS Docs in its config repo
// the way it installs agents: `docs.ts` re-exports this package's classes and the root package.json
// pins its build (`docsModule`), so the processors run the build the project chose, and a commit to
// the pin upgrades every doc on its next call. The Docs app then calls `ensureDoc` from the browser
// as a doc opens. Nothing here is the runtime.
import type { FacetSpec, IterateContextApi } from "iterate/api";
import {
  COMMIT_NOTICED,
  DOC_LEFT,
  DOC_OPENED,
  docContextPath,
  EDIT_FRAME,
  type DocRef,
} from "./frames.ts";

/** The config module that exports the processors' classes. */
export const docsModule = {
  path: "docs.ts",
  content: 'export { DocDurableObject, DocsDurableObject } from "@iterate-com/docs";\n',
};

/** One of the processors: `className` from `docs.ts` of the project's published config. */
export function docsFacetSpec(className: "DocDurableObject" | "DocsDurableObject"): FacetSpec {
  return { className, mainModule: docsModule.path, source: ["itx", ["cd", "/"], "config"] };
}

/** The context co-editing `doc` (a repo and a path in it), set up: the root's docs processor
 *  (root.ts), the doc marked opened, and the doc's processor (processor.ts), which reaches the
 *  doc's repo from its own context (loaded code reaches its whole project). Idempotent: enabling a
 *  row again appends nothing. */
export async function ensureDoc(
  project: Pick<IterateContextApi, "cd" | "append" | "processors">,
  doc: DocRef,
): Promise<IterateContextApi> {
  await project.processors.enable("docs", {
    ...docsFacetSpec("DocsDurableObject"),
    consumes: ["events.iterate.com/repo/commit-completed", DOC_OPENED],
  });
  const contextPath = docContextPath(doc);
  // one per doc: an open of a doc already opened appends nothing
  await project.append({
    type: DOC_OPENED,
    payload: { repo: doc.repo, path: doc.path },
    idempotencyKey: `${DOC_OPENED}:${contextPath}`,
  });
  const context = project.cd(contextPath);
  await context.processors.enable("doc", {
    ...docsFacetSpec("DocDurableObject"),
    consumes: [EDIT_FRAME, COMMIT_NOTICED, DOC_LEFT],
  });
  return context;
}
