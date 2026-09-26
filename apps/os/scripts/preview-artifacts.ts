// scripts/preview-artifacts.ts — a preview's Artifacts namespace (not auto-provisioned: created by
// the deploy, deleted by the delete and the sweep), and the Cloudflare refusal predicate every
// preview resource delete tells an expected answer apart by. Its own module so the create's and the
// delete's loops unit-test against a fake API (preview-artifacts.test.ts); scripts/preview.ts is
// the caller.
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { OsEnv } from "../../../envs.ts";
import { onCallMention } from "../../../scripts/ci/slack.ts";
import { CloudflareApiError, type EnvContext } from "../../../scripts/lib/env-context.ts";

/** The Cloudflare API on the parent's account (scripts/lib/env-context.ts: the envelope checked,
 *  429s retried, a truncated listing refused). */
export type Cf = EnvContext<OsEnv>["cf"];

export type ArtifactsNamespaceRow = { namespace: string; repo_count?: number; created_at?: string };

/** Cloudflare's error envelope, the codes only — what a refusal is told apart by. */
const CloudflareErrors = z.array(z.object({ code: z.number() }));

/** A Cloudflare refusal with this status and error code. Each one used here was measured:
 *  Artifacts 404/10200 (no such namespace, or repo), 409/10202 (namespace still holds repos),
 *  409/10305 (another delete of the namespace in flight: deleteArtifactsNamespace), 409/10306 and
 *  409/10201 (the namespace's activation still settling: ensureArtifactsNamespace); KV
 *  404/10013 (no such namespace); R2 404/10006 (no such bucket); Worker Previews 404/10025 (no such
 *  preview). */
export const isCloudflareError = (error: unknown, status: number, code: number) =>
  error instanceof CloudflareApiError &&
  error.status === status &&
  (CloudflareErrors.safeParse(error.details).data ?? []).some((entry) => entry.code === code);

/** How many rounds of a namespace delete may meet a Cloudflare 5xx before the delete gives up; the
 *  wait before the next round doubles from 2 s to 15 s at most (~1.5 min in all). The Artifacts API
 *  answered 500/10400 "An internal error occurred." on and off for nine minutes on 2026-09-23
 *  (20:33–20:42 UTC): two PR-close deletes each failed on one repo delete. */
const MAX_PLATFORM_FAILURE_ROUNDS = 8;

/** How many rounds, 2 s apart, an empty namespace may answer "not empty" before it is reported
 *  stuck (~2 minutes). Accepted repo deletes land well inside that: 89 landed in under 15 s in the
 *  2026-09-24 sweep. */
const STUCK_AFTER_REFUSED_ROUNDS = 60;

/** An Artifacts namespace Cloudflare will not delete: its repos list reads empty, yet the namespace
 *  delete keeps answering 409/10202 "Namespace is not empty". A platform fault, not ours, and not
 *  one a retry heals: pr2817's namespace has held `repo_count: 1` with an empty repos list since at
 *  least 2026-09-23 (every list parameter tried; alone, 150 of 150 deletes answered 10202 on
 *  2026-09-24). The sweep pages it (preview.ts) and tries again the next night. */
export type StuckArtifactsNamespace = {
  namespace: string;
  /** Cloudflare's own count, which disagrees with its empty repos list. */
  repoCount: number | undefined;
  createdAt: string | undefined;
};

/** How many reads, 2 s apart, a namespace may answer 404 after its create answered 409/10306 or
 *  409/10201 before the ensure gives up (~1 minute). A create racing another answers either at
 *  once, and the namespace reads 200 within a second (measured 2026-09-26); a deploy's lone create
 *  took 20 s to answer 10306. */
const ACTIVATION_READS = 30;

/** A preview's namespace, by name. The worker's repo create does NOT provision one: on a missing
 *  namespace it fails with "Namespace is not active" (measured 2026-09-22), and the binding names
 *  the namespace only.
 *
 *  Cloudflare answers a create with 409/10306 ("Namespace activation is already in progress") or
 *  409/10201 ("Namespace already exists") while the namespace's activation is still settling: when
 *  a concurrent create races it (measured 2026-09-26), and when a slow create conflicts with itself
 *  (#3204's deploy, where no other create existed). The namespace is read again until it reads 200,
 *  each wait logged as `preview.platform-failure-retry`, at most ACTIVATION_READS times. */
export async function ensureArtifactsNamespace(
  cf: Cf,
  artifactsNamespaceName: string,
  wait = (ms: number) => sleep(ms),
) {
  const route = `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`;
  if (await readArtifactsNamespace(cf, route)) {
    console.log(`found Artifacts namespace ${artifactsNamespaceName}`);
    return;
  }
  const refusedWith = await cf("/artifacts/namespaces", {
    method: "POST",
    body: JSON.stringify({ namespace: artifactsNamespaceName }),
  }).then(
    () => undefined,
    (error) => {
      const code = [10306, 10201].find((known) => isCloudflareError(error, 409, known));
      if (!code) throw error;
      return code;
    },
  );
  if (!refusedWith) {
    console.log(`created Artifacts namespace ${artifactsNamespaceName}`);
    return;
  }
  for (let read = 1; ; read++) {
    if (await readArtifactsNamespace(cf, route)) break;
    if (read === ACTIVATION_READS)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} still reads 404 after ${read} reads 2 s apart; its create answered 409/${refusedWith}`,
      );
    console.warn({
      event: "preview.platform-failure-retry",
      name: artifactsNamespaceName,
      read,
      status: 409,
      codes: [refusedWith],
      retryInMs: 2000,
    });
    await wait(2000);
  }
  console.log(`found Artifacts namespace ${artifactsNamespaceName} once its activation landed`);
}

/** Delete a preview's Artifacts namespace: every repo first (the API refuses a namespace that is
 *  not empty), then the namespace. A repo delete is ACCEPTED (202) and lands after the answer, so
 *  the list is read again until it is empty and the namespace delete stops answering "not empty";
 *  a ceiling keeps that bounded. A namespace that does not exist — a preview deleted before its
 *  deploy created one, a re-run of the cleanup job, the sweep racing the close job — is the
 *  expected case.
 *
 *  A round that meets a Cloudflare 5xx — a platform failure; every request here is idempotent and
 *  the next round lists what is left — logs `preview.platform-failure-retry`, waits and goes again,
 *  at most MAX_PLATFORM_FAILURE_ROUNDS times, after which the 5xx surfaces as what it is.
 *
 *  An empty namespace that keeps answering "not empty" for STUCK_AFTER_REFUSED_ROUNDS is Cloudflare's
 *  (StuckArtifactsNamespace): logged as `preview.platform-failure-stuck-namespace` and resolved to,
 *  not thrown, so the caller decides (the sweep pages it). It throws only when this run could not
 *  act.
 *
 *  No single answer says a namespace is gone. While any delete of it is in flight, Cloudflare
 *  answers some requests as if it were: on 2026-09-24, with three other delete loops running
 *  against pr2817's stuck namespace, 10 of 60 deletes answered 409/10305 ("deletion in
 *  progress"), 9 of 60 reads 404/10200 and 12 of 60 account listings left it out, and it stayed.
 *  Taking 10305 as deleted is how the 2026-09-23 sweep reported pr2817's namespace deleted. So an
 *  accepted delete is confirmed by reads (confirmedGone), and 10305 is waited out like 10202. */
export async function deleteArtifactsNamespace(
  cf: Cf,
  artifactsNamespaceName: string,
  wait = (ms: number) => sleep(ms),
): Promise<StuckArtifactsNamespace | undefined> {
  const route = `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`;
  /** A read that met a 5xx: the namespace's state unknown, to be read again on a later round. */
  const readThroughPlatformFailure = () =>
    readArtifactsNamespace(cf, route).catch((error) => {
      if (!isPlatformFailure(error)) throw error;
      return "unread" as const;
    });
  /** Gone when three reads 2 s apart all answer 404: one 404 can be another delete in flight. */
  const confirmedGone = async () => {
    for (let read = 0; read < 3; read++) {
      if (read > 0) await wait(2000);
      if (await readThroughPlatformFailure()) return false;
    }
    return true;
  };
  // One read, not three: a 404 here while another run's delete is in flight leaves the namespace to
  // that run, and to the sweep if it fails.
  if (!(await readArtifactsNamespace(cf, route))) {
    console.warn(`Artifacts namespace ${artifactsNamespaceName} did not exist; continuing.`);
    return undefined;
  }
  let deletedRepos = 0;
  let platformFailureRounds = 0;
  let refusedRounds = 0;
  for (let round = 1; ; round++) {
    if (round > 200)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} still lists repos after ${deletedRepos} repo deletes`,
      );
    const outcome: ArtifactsDeleteRound = await deleteArtifactsRound(cf, route).catch((error) => {
      if (!isPlatformFailure(error)) throw error;
      return { deletedRepos: 0, next: "again", platformFailure: error };
    });
    deletedRepos += outcome.deletedRepos;
    if (outcome.deletedRepos > 0) refusedRounds = 0;
    if (outcome.next === "accepted" && (await confirmedGone())) break;
    if (outcome.next === "accepted" || outcome.next === "not-empty") refusedRounds++;
    if (refusedRounds >= STUCK_AFTER_REFUSED_ROUNDS) {
      const read = await readThroughPlatformFailure();
      const row = read === "unread" ? undefined : read;
      const stuck = {
        namespace: artifactsNamespaceName,
        repoCount: row?.repo_count,
        createdAt: row?.created_at,
      };
      console.warn({
        event: "preview.platform-failure-stuck-namespace",
        ...stuck,
        listedRepos: 0,
        refusedRounds,
      });
      return stuck;
    }
    if (outcome.platformFailure) {
      const error = outcome.platformFailure;
      if (++platformFailureRounds > MAX_PLATFORM_FAILURE_ROUNDS) throw error;
      console.warn({
        event: "preview.platform-failure-retry",
        name: artifactsNamespaceName,
        round,
        platformFailureRounds,
        status: error.status,
        codes: (CloudflareErrors.safeParse(error.details).data ?? []).map((entry) => entry.code),
        message: error.message,
      });
      await wait(Math.min(2000 * 2 ** (platformFailureRounds - 1), 15_000));
    } else if (outcome.next !== "again") await wait(2000); // accepted deletes still landing
  }
  console.log(`deleted Artifacts namespace ${artifactsNamespaceName} (${deletedRepos} repos)`);
  return undefined;
}

/** The sweep's page for the namespaces Cloudflare would not delete: what to escalate, and to whom. */
export function renderStuckArtifactsNamespacesPage(
  stuck: StuckArtifactsNamespace[],
  jobUrl: string | undefined,
) {
  return [
    `🚨 preview sweep: Cloudflare will not delete ${stuck.length} Artifacts namespace(s) ${onCallMention}`,
    ...stuck.map(
      ({ namespace, repoCount, createdAt }) =>
        `• ${namespace}: repo_count ${repoCount ?? "?"} but no repos listed; the namespace DELETE answers 409/10202 "Namespace is not empty"${createdAt ? ` (created ${createdAt.slice(0, 10)})` : ""}`,
    ),
    "A Cloudflare Artifacts fault, not a commit's: escalate it to Cloudflare with these names. The sweep tries again each night.",
    jobUrl && `<${jobUrl}|sweep run>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The namespace's row, or undefined for its 404/10200. The namespace itself is what answers "does
 *  not exist": its repos list answers an empty page for a missing namespace (measured
 *  2026-09-22). */
const readArtifactsNamespace = (cf: Cf, route: string) =>
  cf<ArtifactsNamespaceRow>(route).catch((error) => {
    if (isCloudflareError(error, 404, 10200)) return undefined;
    throw error;
  });

/** A Cloudflare 5xx: the platform failed the request, not refused it. */
const isPlatformFailure = (error: unknown): error is CloudflareApiError =>
  error instanceof CloudflareApiError && error.status >= 500;

type ArtifactsDeleteRound = {
  deletedRepos: number;
  /** `again`: repos were deleted, list again; `accepted`: the namespace delete was accepted (or it
   *  answered 404), to be confirmed; `not-empty`: it answered 409/10202 or 409/10305 */
  next: "accepted" | "again" | "not-empty";
  /** the round's first 5xx — its other requests still ran */
  platformFailure?: CloudflareApiError;
};

/** One round: the first page of repos (read again each round until it is empty — that is the
 *  loop's pagination), each deleted; once none is left, the namespace. A repo delete's 5xx is
 *  returned, after the round's other deletes ran; any other failure throws. */
async function deleteArtifactsRound(cf: Cf, route: string): Promise<ArtifactsDeleteRound> {
  // `page=1` is named (env-context refuses a truncated listing that names no page).
  const repos = await cf<{ name: string }[]>(`${route}/repos?limit=200&page=1`);
  if (repos.length > 0) {
    const platformFailures: CloudflareApiError[] = [];
    // ten at a time: one delete answers in ~1 s (measured), and a preview's e2e run leaves hundreds
    for (let i = 0; i < repos.length; i += 10) {
      await Promise.all(
        repos.slice(i, i + 10).map((repo) =>
          // one already gone (a delete accepted on an earlier round) is fine
          cf(`${route}/repos/${encodeURIComponent(repo.name)}`, { method: "DELETE" }).catch(
            (error) => {
              if (isPlatformFailure(error)) platformFailures.push(error);
              else if (!isCloudflareError(error, 404, 10200)) throw error;
            },
          ),
        ),
      );
    }
    return {
      deletedRepos: repos.length - platformFailures.length,
      next: "again",
      platformFailure: platformFailures[0],
    };
  }
  // Accepted, or already gone (the sweep and the close job can race): the caller confirms it. Not
  // empty yet (accepted repo deletes still landing) or another delete of it in flight: asked again.
  const accepted = await cf(route, { method: "DELETE" }).then(
    () => true,
    (error) => {
      if (isCloudflareError(error, 404, 10200)) return true;
      if (isCloudflareError(error, 409, 10202) || isCloudflareError(error, 409, 10305))
        return false;
      throw error;
    },
  );
  return { deletedRepos: 0, next: accepted ? "accepted" : "not-empty" };
}
