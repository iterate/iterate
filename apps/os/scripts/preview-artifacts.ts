// scripts/preview-artifacts.ts — a preview's Artifacts namespace (not auto-provisioned: created by
// the deploy, deleted by the delete and the sweep), and the Cloudflare refusal predicate every
// preview resource delete tells an expected answer apart by. Its own module so the delete's loop
// unit-tests against a fake API (preview-artifacts.test.ts); scripts/preview.ts is the caller.
import { z } from "zod";
import type { OsEnv } from "../../../envs.ts";
import { CloudflareApiError, type EnvContext } from "../../../scripts/lib/env-context.ts";

/** The Cloudflare API on the parent's account (scripts/lib/env-context.ts: the envelope checked,
 *  429s retried, a truncated listing refused). */
export type Cf = EnvContext<OsEnv>["cf"];

export type ArtifactsNamespaceRow = { namespace: string; repo_count?: number; created_at?: string };

/** Cloudflare's error envelope, the codes only — what a refusal is told apart by. */
const CloudflareErrors = z.array(z.object({ code: z.number() }));

/** A Cloudflare refusal with this status and error code. Each one used here was measured:
 *  Artifacts 404/10200 (no such namespace, or repo), 409/10202 (namespace still holds repos) and
 *  409/10305 (namespace deletion already in progress); KV
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

/** A preview's namespace, by name. The worker's repo create does NOT provision one: on a missing
 *  namespace it fails with "Namespace is not active" (measured 2026-09-22), and the binding names
 *  the namespace only. */
export async function ensureArtifactsNamespace(cf: Cf, artifactsNamespaceName: string) {
  const existing = await cf<ArtifactsNamespaceRow>(
    `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`,
  ).catch((error) => {
    if (isCloudflareError(error, 404, 10200)) return undefined;
    throw error;
  });
  if (!existing)
    await cf("/artifacts/namespaces", {
      method: "POST",
      body: JSON.stringify({ namespace: artifactsNamespaceName }),
    });
  console.log(`${existing ? "found" : "created"} Artifacts namespace ${artifactsNamespaceName}`);
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
 *  at most MAX_PLATFORM_FAILURE_ROUNDS times, after which the 5xx surfaces as what it is. */
export async function deleteArtifactsNamespace(
  cf: Cf,
  artifactsNamespaceName: string,
  wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const route = `/artifacts/namespaces/${encodeURIComponent(artifactsNamespaceName)}`;
  // The namespace itself is what answers "does not exist" (404, code 10200); its repos list answers
  // an empty page for a missing namespace (measured 2026-09-22), so the check is on the namespace.
  const existing = await cf<ArtifactsNamespaceRow>(route).catch((error) => {
    if (isCloudflareError(error, 404, 10200)) return undefined;
    throw error;
  });
  if (!existing)
    return console.warn(`Artifacts namespace ${artifactsNamespaceName} did not exist; continuing.`);
  let deletedRepos = 0;
  let platformFailureRounds = 0;
  for (let round = 1; ; round++) {
    if (round > 200)
      throw new Error(
        `Artifacts namespace ${artifactsNamespaceName} is still not empty after ${deletedRepos} repo deletes`,
      );
    const outcome: ArtifactsDeleteRound = await deleteArtifactsRound(cf, route).catch((error) => {
      if (!isPlatformFailure(error)) throw error;
      return { deletedRepos: 0, next: "again", platformFailure: error };
    });
    deletedRepos += outcome.deletedRepos;
    if (outcome.next === "done") break;
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
    } else if (outcome.next === "not-empty") await wait(2000); // accepted deletes still landing
  }
  console.log(`deleted Artifacts namespace ${artifactsNamespaceName} (${deletedRepos} repos)`);
}

/** A Cloudflare 5xx: the platform failed the request, not refused it. */
const isPlatformFailure = (error: unknown): error is CloudflareApiError =>
  error instanceof CloudflareApiError && error.status >= 500;

type ArtifactsDeleteRound = {
  deletedRepos: number;
  /** `again`: repos were deleted, list again; `not-empty`: the namespace still holds some */
  next: "done" | "again" | "not-empty";
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
  // gone under this run (the sweep and the close job can race) is deleted, and so is one whose
  // deletion Cloudflare already has in progress (409/10305; one sat there with `repo_count: 1` and
  // an empty repos list for minutes, 2026-09-23)
  const deleted = await cf(route, { method: "DELETE" }).then(
    () => true,
    (error) => {
      if (isCloudflareError(error, 404, 10200) || isCloudflareError(error, 409, 10305)) return true;
      if (!isCloudflareError(error, 409, 10202)) throw error;
      return false;
    },
  );
  return { deletedRepos: 0, next: deleted ? "done" : "not-empty" };
}
