// scripts/ci/pull-request-body.ts — CI's write of a managed section (markdown-annotator.ts) into a
// pull request's body: the LOC report's (loc-report.ts) and the preview's
// (scripts/os/preview.ts). GitHub has no conditional update for a body: a PATCH replaces it
// whole, so a write spliced onto a body read a moment earlier undoes any version saved in between,
// a person's, an agent's or another CI writer's. GitHub does keep every version it saved (GraphQL
// `userContentEdits`, each with the whole body), so every write is checked against that history,
// and a write that replaced a version it never read is spliced onto that version and sent again.
import type { Octokit } from "@octokit/rest";
import { z } from "zod";

/** One saved version of a pull request's body. */
export type BodyVersion = { body: string; editor: string; editedAt: string };

/** A pull request's body as GitHub holds it: every version, newest first, and a whole-body replace. */
export type PullRequestBody = {
  number: number;
  /** the body now, then each earlier version, newest first */
  versions: () => Promise<[BodyVersion, ...BodyVersion[]]>;
  /** one PATCH, not asked again on a 5xx (scripts/ci/github.ts `askOnce`) */
  replace: (body: string) => Promise<void>;
};

/** The most PATCHes one write sends, failed ones included. A write is sent again when the previous
 *  PATCH failed or a version landed in the second or so around it; three in a row means GitHub keeps
 *  refusing it or the body is being written continuously. */
const MAX_WRITES = 3;

/**
 * Writes `splice(body)` into the PR's body without undoing a version anyone else saves meanwhile.
 * Each round reads the body with its history and splices onto the newest version this call did
 * not write, and it is done when the body is that splice:
 * - a version saved between our read and our PATCH was replaced by the PATCH, and is now the newest
 *   version that is not ours: the next round splices onto it and writes again;
 * - a version saved after our PATCH is the body now: it is kept, and written again only when it
 *   lacks our section.
 * Two edits it cannot keep stay in the PR's edit history, named in the log: a version our PATCH
 * replaced when someone else saved over the PATCH before our next read, since theirs wins
 * (`pull-request-body.edit-overwritten`), and whatever the last of MAX_WRITES PATCHes replaced,
 * named in the error it gives up with.
 * `what` names the write in the log. A PATCH that fails is not sent again: the next round reads
 * anew 5 s later, and finds the body written when the failure was GitHub's answer, not its write.
 */
export async function writePullRequestBody(
  pullRequest: PullRequestBody,
  what: string,
  splice: (body: string) => string,
) {
  const pr = `PR #${pullRequest.number}`;
  /** each body this call PATCHed, and the version it was spliced onto, in the order last sent */
  const writes = new Map<string, BodyVersion>();
  /** every PATCH counts, a failed one sent again with the same body included */
  let patches = 0;
  for (;;) {
    const versions = await pullRequest.versions();
    const base = versions.find((version) => !writes.has(version.body));
    if (!base)
      throw new Error(
        `${pr}'s last ${versions.length} versions are all ${what}: the version to splice onto is out of reach`,
      );
    const [lastWrite, lastBase] = [...writes].at(-1) || [];
    const replaced = lastWrite ? replacedVersion(versions, lastWrite, writes) : undefined;
    if (replaced && replaced !== base && replaced.body !== lastBase?.body)
      console.warn(JSON.stringify(logged("edit-overwritten", pullRequest, what, replaced)));
    const body = splice(base.body);
    if (body === versions[0].body)
      return console.log(
        writes.size
          ? `wrote ${what} into the body of ${pr}`
          : `${pr}'s body already carries ${what}`,
      );
    if (patches === MAX_WRITES)
      throw new Error(
        `could not write ${what} into ${pr}'s body in ${MAX_WRITES} PATCHes: its newest version not ours is ${base.editor}'s of ${base.editedAt}`,
      );
    if (lastBase && base.body !== lastBase.body)
      console.warn(JSON.stringify(logged("edit-kept", pullRequest, what, base)));
    writes.delete(body);
    writes.set(body, base);
    patches++;
    const sent = await pullRequest.replace(body).then(
      () => true,
      (error: unknown) => {
        console.warn(`${error instanceof Error ? error.message : String(error)}; reading anew`);
        return false;
      },
    );
    if (!sent) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/** The version our write `body` replaced, the one just older than it in `versions`, when it is
 *  someone else's: none when the write never landed or it replaced one of ours. */
function replacedVersion(versions: BodyVersion[], body: string, writes: Map<string, BodyVersion>) {
  const at = versions.findIndex((version) => version.body === body);
  const replaced = at >= 0 ? versions[at + 1] : undefined;
  return replaced && !writes.has(replaced.body) ? replaced : undefined;
}

/** A warn line naming someone else's version: one this call spliced onto (`edit-kept`), or one it
 *  replaced and could not splice onto (`edit-overwritten`). */
function logged(
  outcome: "edit-kept" | "edit-overwritten",
  pullRequest: PullRequestBody,
  what: string,
  version: BodyVersion,
) {
  return {
    event: `pull-request-body.${outcome}`,
    pullRequest: pullRequest.number,
    what,
    editor: version.editor,
    editedAt: version.editedAt,
  };
}

/** The pull request `number` of `repo`: its versions read in one GraphQL query, so the body and its
 *  history are one answer, and its body replaced by one REST PATCH. */
export function githubPullRequestBody(
  github: Octokit,
  repo: { owner: string; repo: string },
  number: number,
): PullRequestBody {
  return {
    number,
    versions: async () =>
      bodyVersions(
        PullRequestVersions.parse(await github.graphql(VERSIONS_QUERY, { ...repo, number }))
          .repository.pullRequest,
      ),
    replace: async (body) => {
      await github.rest.pulls.update({
        ...repo,
        pull_number: number,
        body,
        request: { askOnce: true },
      });
    },
  };
}

/** The versions a write reads back: ours are at most MAX_WRITES of them, so the version it spliced
 *  onto is within reach unless 17 others land in the few seconds the write takes. */
const VERSIONS_QUERY = /* GraphQL */ `
  query PullRequestBodyVersions($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        body
        createdAt
        lastEditedAt
        author {
          login
        }
        editor {
          login
        }
        userContentEdits(first: 20) {
          nodes {
            diff
            editedAt
            deletedAt
            editor {
              login
            }
          }
        }
      }
    }
  }
`;

const Login = z.object({ login: z.string() }).nullable();

const PullRequestVersions = z.object({
  repository: z.object({
    pullRequest: z.object({
      body: z.string(),
      createdAt: z.string(),
      lastEditedAt: z.string().nullable(),
      author: Login,
      editor: Login,
      userContentEdits: z.object({
        nodes: z.array(
          z
            .object({
              diff: z.string().nullable(),
              editedAt: z.string(),
              deletedAt: z.string().nullable(),
              editor: Login,
            })
            .nullable(),
        ),
      }),
    }),
  }),
});

/** The body now, then each earlier version, newest first. GitHub starts the history at the first
 *  edit, with the version the PR was opened with, whose `diff` is null when it was empty; a
 *  revision someone deleted from the history has `deletedAt` and no body, and is left out. The
 *  newest history entry is the body now, unless the history has not caught up with it. A deleted
 *  account edits as `ghost`, as GitHub shows it. */
function bodyVersions(
  pullRequest: z.infer<typeof PullRequestVersions>["repository"]["pullRequest"],
): [BodyVersion, ...BodyVersion[]] {
  const current = {
    body: pullRequest.body,
    editor: (pullRequest.editor || pullRequest.author)?.login || "ghost",
    editedAt: pullRequest.lastEditedAt || pullRequest.createdAt,
  };
  const earlier = pullRequest.userContentEdits.nodes.flatMap((edit) =>
    edit && !edit.deletedAt
      ? [{ body: edit.diff || "", editor: edit.editor?.login || "ghost", editedAt: edit.editedAt }]
      : [],
  );
  return [current, ...(earlier[0]?.body === current.body ? earlier.slice(1) : earlier)];
}
