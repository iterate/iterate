// scripts/preview-delete.ts — A PER-COMMIT DEPLOYMENT DELETED: its workers, then its KV, R2 bucket,
// D1 and Artifacts namespace (preview-artifacts.ts), for scripts/preview.ts's cleanup of the
// deployments a run's own supersedes, a closed PR's delete and the nightly sweep. Two of them can
// delete one deployment at once: Main OS e2e runs every main commit, and two runs close together
// both supersede the deployment before them. So a member already gone counts as deleted, told
// apart by Cloudflare's answer for that kind (GONE), and any other answer is a failure. Its own
// module so the deletes unit-test against a fake account (preview-delete.test.ts).
import { setTimeout as sleep } from "node:timers/promises";
import {
  deleteArtifactsNamespace,
  isCloudflareError,
  type Cf,
  type StuckArtifactsNamespace,
} from "./preview-artifacts.ts";
import type { PreviewDeploymentListing, PreviewMember } from "./preview-sweep.ts";

/** Cloudflare answers, as `[status, code]`, that each mean "already gone". */
type Gone = [status: number, code: number][];

/** Cloudflare's answers that say what a DELETE names is already gone. Each measured on the
 *  dev/preview account (2026-09-29, a delete after one that landed, and the loser of two racing
 *  deletes): a worker 404/10007; a KV namespace 404/10013; a D1 404/7404; an R2 bucket 404/10006;
 *  an R2 object 200/10007 NoSuchKey with `success: false` (R2's error codes list it as 404, also
 *  taken), or 404/10006 once its bucket is gone too. An Artifacts namespace's and repo's is
 *  404/10200 (preview-artifacts.ts). */
const GONE = {
  worker: [[404, 10007]],
  kv: [[404, 10013]],
  d1: [[404, 7404]],
  r2Bucket: [[404, 10006]],
  r2Object: [
    [200, 10007],
    [404, 10007],
    [404, 10006],
  ],
} satisfies Record<string, Gone>;

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** DELETE `route`: true once Cloudflare deleted it, false when it answered one of `gone`. Any other
 *  failure throws. */
const deleteUnlessGone = (cf: Cf, route: string, gone: Gone) =>
  cf(route, { method: "DELETE" }).then(
    () => true,
    (error: unknown) => {
      if (gone.some(([status, code]) => isCloudflareError(error, status, code))) return false;
      throw error;
    },
  );

/** DELETE `route`, `what` logged as deleted or as already gone. */
async function deleteMember(cf: Cf, what: string, route: string, gone: Gone) {
  const deleted = await deleteUnlessGone(cf, route, gone);
  console.log(deleted ? `deleted ${what}` : `${what} was already gone`);
}

/** A KV namespace, by its listing's row. */
export const deleteKvNamespace = (cf: Cf, row: { id: string; title: string }) =>
  deleteMember(cf, `KV namespace ${row.title}`, `/storage/kv/namespaces/${row.id}`, GONE.kv);

/** A D1, by its listing's row. */
export const deleteD1 = (cf: Cf, row: { uuid: string; name: string }) =>
  deleteMember(cf, `D1 ${row.name}`, `/d1/database/${row.uuid}`, GONE.d1);

/** Delete an R2 bucket: its objects first (the API refuses a bucket that still holds any), then the
 *  bucket. The first thousand-key page is read again until it is empty, twenty deletes in flight —
 *  a preview's e2e run leaves tens, the soak preview's bucket held 1,908 (measured 2026-09-23) — and
 *  a ceiling keeps that bounded. The loser of two racing bucket deletes answers 500/10001 (measured
 *  2026-09-29), which the API client sends again, and the retry answers 404/10006. */
export async function deleteR2Bucket(cf: Cf, bucketName: string) {
  const route = `/r2/buckets/${bucketName}`;
  let deletedObjects = 0;
  let goneObjects = 0;
  for (let round = 1; ; round++) {
    if (round > 50)
      throw new Error(
        `R2 bucket ${bucketName} still holds objects after ${deletedObjects} deletes`,
      );
    const objects = await cf<{ key: string }[]>(`${route}/objects?per_page=1000`).catch((error) => {
      if (isCloudflareError(error, 404, 10006)) return undefined;
      throw error;
    });
    if (!objects) return console.log(`R2 bucket ${bucketName} was already gone`);
    if (objects.length === 0) break;
    for (let i = 0; i < objects.length; i += 20) {
      const deleted = await Promise.all(
        objects.slice(i, i + 20).map(({ key }) =>
          // a key's slashes are its path: each segment encoded, the slashes kept
          deleteUnlessGone(
            cf,
            `${route}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
            GONE.r2Object,
          ),
        ),
      );
      deletedObjects += deleted.filter(Boolean).length;
      goneObjects += deleted.filter((answer) => !answer).length;
    }
  }
  await deleteMember(
    cf,
    `R2 bucket ${bucketName} (${deletedObjects} objects deleted, ${goneObjects} already gone)`,
    route,
    GONE.r2Bucket,
  );
}

/** A deployment's workers first, so nothing writes to what goes next, then its KV, R2 bucket, D1
 *  and Artifacts namespace; each member one at a time settles before any failure is named.
 *  Resolves to its Artifacts namespace when Cloudflare will not delete it (StuckArtifactsNamespace):
 *  the rest still goes, and the nightly sweep retries and pages it. `wait` is the Artifacts
 *  delete's wait between rounds. */
async function deletePreviewDeployment(
  cf: Cf,
  deployment: PreviewDeploymentListing,
  wait = (ms: number) => sleep(ms),
) {
  const failures: string[] = [];
  const stuck: StuckArtifactsNamespace[] = [];
  const settle = async (
    members: PreviewMember[],
    remove: (member: PreviewMember) => Promise<void>,
  ) => {
    const results = await Promise.allSettled(members.map(remove));
    results.forEach((result, index) => {
      if (result.status === "rejected")
        failures.push(`${members[index]!.name}: ${describe(result.reason)}`);
    });
  };
  await settle(
    deployment.members.filter((member) => member.kind === "worker"),
    // `force`: a worker with Durable Object namespaces is refused without it
    ({ name }) =>
      deleteMember(cf, `worker ${name}`, `/workers/scripts/${name}?force=true`, GONE.worker),
  );
  await settle(
    deployment.members.filter((member) => member.kind !== "worker"),
    async (member) => {
      if (member.kind === "kv") return deleteKvNamespace(cf, { id: member.id, title: member.name });
      if (member.kind === "r2") return deleteR2Bucket(cf, member.name);
      if (member.kind === "d1") return deleteD1(cf, { uuid: member.id, name: member.name });
      const refused = await deleteArtifactsNamespace(cf, member.name, wait);
      if (refused) stuck.push(refused);
    },
  );
  if (failures.length > 0)
    throw new Error(
      `${deployment.name}: ${failures.length} member(s) not deleted\n  ${failures.join("\n  ")}`,
    );
  console.log(`deleted deployment ${deployment.name} (${deployment.members.length} members)`);
  return stuck;
}

/** Delete each of `deployments`, then name the ones that did not go. A namespace Cloudflare will
 *  not delete is not a failure: the caller reports on a commit that did not cause it, and the
 *  nightly sweep retries and pages it. */
export async function deletePreviewDeployments(
  cf: Cf,
  deployments: PreviewDeploymentListing[],
  wait = (ms: number) => sleep(ms),
) {
  const failures: string[] = [];
  const stuckNamespaces: StuckArtifactsNamespace[] = [];
  for (const deployment of deployments) {
    await deletePreviewDeployment(cf, deployment, wait).then(
      (stuck) => stuckNamespaces.push(...stuck),
      (error) => failures.push(describe(error)),
    );
  }
  return { failures, stuckNamespaces };
}
