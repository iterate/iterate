// docs/install.ts — how a doc gets co-edited (frames.ts). A project INSTALLS Docs in its config repo
// the way it installs agents: `docs.ts` re-exports this package's classes and the root package.json
// pins its build (`docsModule`), so the processors run the build the project chose, and a commit to
// the pin upgrades every doc on its next call. The Docs app then calls `ensureDoc` from the browser
// as a doc opens; `installDocs` is how a project without it gets it. Nothing here is the runtime.
import type { FacetSpec, IterateContextApi, RepoHandle } from "iterate/api";
import { z } from "zod";
// the page imports this: frames.ts and comments.ts only, never contract.ts, whose
// iterate/stream/processor needs node:async_hooks
import { commentEvents } from "./comments.ts";
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

const RootManifest = z.object({ dependencies: z.record(z.string(), z.string()).optional() });

/** The guide an agent follows to work on docs (this package's AGENTS.md), on main. */
export const docsAgentGuide =
  "https://raw.githubusercontent.com/iterate/iterate/main/packages/docs/AGENTS.md";

/** What `installDocs` adds to the config's AGENTS.md, which an agent on the platform's MCP server
 *  is told to read first: where the guide is. */
export const docsAgentsSection = `## Docs

Docs (\`docs.ts\`, @iterate-com/docs) co-edits this project's files in the browser. An agent edits a
doc by committing it, and comments on one with events on its context, \`/docs/<repo name>/<path>\`,
as ${docsAgentGuide} says.
`;

/** Install Docs in a project's config at `version` (a pkg.pr.new build at its commit, or an npm
 *  version): `docs.ts` and the root package.json's pin, one commit, then the config's publication
 *  of it. Resolves once the project runs it; throws with the platform's reason when it refused the
 *  commit. `upgradeVoice` (@iterate-com/voice/install) does the same for voice. */
export async function installDocs(
  project: Pick<IterateContextApi, "waitForEvent"> & {
    repos: { get(path: string): Pick<RepoHandle, "tip" | "readFile" | "commitFiles"> };
  },
  version: string,
) {
  const repo = project.repos.get("/repos/config");
  const tip = await repo.tip();
  const manifest: Record<string, unknown> = JSON.parse(
    (await repo.readFile("package.json")) || "{}",
  );
  // the pin set in place: every other field and dependency keeps its value and its order
  const { dependencies } = RootManifest.parse(manifest);
  manifest.dependencies = { ...dependencies, "@iterate-com/docs": version };
  // the guide's pointer, once: a section already there (a reinstall, the owner's own words) stays
  const agents = (await repo.readFile("AGENTS.md")) || "";
  const { commitOid } = await repo.commitFiles({
    message: `Install @iterate-com/docs at ${version}`,
    parent: tip,
    changes: [
      docsModule,
      { path: "package.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...(agents.includes(docsAgentGuide)
        ? []
        : [
            {
              path: "AGENTS.md",
              content: agents ? `${agents.trimEnd()}\n\n${docsAgentsSection}` : docsAgentsSection,
            },
          ]),
    ],
  });
  // one deadline for the whole wait: a give-up for now does not restart it
  const deadline = Date.now() + 120_000;
  for (let afterOffset = 0; ;) {
    const outcome = await project.waitForEvent({
      type: [
        "events.iterate.com/project/worker-updated",
        "events.iterate.com/project/worker-update-failed",
      ],
      payload: { commitOid },
      afterOffset,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (outcome.type === "events.iterate.com/project/worker-updated") return commitOid;
    if (!outcome.payload?.unavailable)
      throw new Error(`Docs was not installed: ${String(outcome.payload?.error)}`);
    // the platform gave up for now and still owes the commit: its outcome comes after this one
    afterOffset = outcome.offset;
  }
}

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
    // DocContract's consumes
    consumes: [EDIT_FRAME, COMMIT_NOTICED, DOC_LEFT, ...commentEvents],
  });
  return context;
}
