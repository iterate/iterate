// THE FLAKE DASHBOARD'S INPUT: the flake records and suite summaries that CI's test runs keep in
// R2, in each run's test evidence folder (docs/test-evidence.md). ./update.ts reads the recent ones
// every hour and ./dashboard.ts computes issue #2580 from them; nothing is kept between runs.
//
// A folder's flake records are `flake-records/<suite>/*.jsonl` beside that suite's
// `suite-summary.json` (the e2e jobs' `preview-e2e` and `specs`), or `flake-records/*.jsonl` for
// the Test job, whose one suite is `unit`. A folder counts once its `manifest.json` is listed: the
// upload writes the manifest last, so a folder without one is still uploading or failed part way.
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import {
  HttpAnswerError,
  httpPlatformFailure,
  PLATFORM_FAILURE_DELAYS_MS,
  retryPlatformFailures,
} from "@iterate-com/shared/platform-retry";
import { FlakeSuiteSummary } from "@iterate-com/shared/test-support/flake-suite-summary";
import { mapConcurrent } from "../depot.ts";

/**
 * One test outcome, as `@iterate-com/shared/test-support/flake-record` writes it: createFlake,
 * createFailing, and the telemetry reporters' kind "unknown" records for plain tests that needed a
 * retry (retried-pass) or failed every attempt (unexpected-error), with no pattern but an error.
 */
export const FlakeRecord = z.object({
  name: z.string().min(1).max(1_000),
  kind: z.enum(["flake", "failing", "unknown"]),
  outcome: z.enum([
    "pass",
    "flake-fail",
    "unexpected-error",
    "pinned-fail",
    "unexpected-pass",
    "retried-pass",
  ]),
  pattern: z.string().min(1).max(2_000).optional(),
  durationMs: z.number().nonnegative(),
  at: z.string().min(1),
  error: z.string().max(4_000).optional(),
});
export type FlakeRecord = z.infer<typeof FlakeRecord>;

/** One suite's records and summary from one CI test run. */
export type SuiteRun = {
  suite: string;
  /**
   * Filed under `trust=main`: a push to main that tested its own commit
   * (docs/test-evidence.md#object-keys).
   */
  main: boolean;
  /** When the run's manifest reached R2, which orders runs. */
  uploadedAt: string;
  /** Among its suite's `recentRuns.newest` runs on any branch, which the Cost section prices. */
  newest: boolean;
  records: FlakeRecord[];
  /** Read for the newest runs only (`recentRuns`); a unit suite's summary is about 700 KB. */
  summary: z.infer<typeof FlakeSuiteSummary> | undefined;
};

/**
 * What one hourly run reads. Every main run of the last `mainDays` gives its records, which the
 * wrapped tests' main stats and lifecycle streaks count (a streak proposal needs up to 25 runs over
 * two days). Each suite's newest `newest` runs on any branch give records and summaries too: the
 * squares, the last three complete runs a wrapped test must appear in, and the Cost section's
 * last 100 complete runs. Each suite's newest `newestMain` main runs give summaries, whose per-test
 * outcomes count an unknown flake's 20 passes.
 */
export const recentRuns = { mainDays: 7, newest: 150, newestMain: 30 };

/**
 * The suite runs to read from a listing of `evidence/ci/` (`recentRuns`), newest first. A PR run
 * outside its suite's newest is left out; a main run outside them keeps its records only.
 */
export function planReads(objects: { key: string; lastModified: string }[], now: Date) {
  type Folder = {
    main: boolean;
    manifestAt?: string;
    suites: Map<string, { recordKeys: string[]; summaryKey?: string }>;
  };
  const folders = new Map<string, Folder>();
  for (const { key, lastModified } of objects) {
    const match =
      /^(?<folder>evidence\/ci\/trust=(?<trust>main|pr)\/date=[^/]+\/job=[^/]+\/[^/]+\/)(?<path>.+)$/u.exec(
        key,
      )?.groups;
    if (!match) continue;
    const folder: Folder = folders.get(match.folder!) || {
      main: match.trust === "main",
      suites: new Map(),
    };
    folders.set(match.folder!, folder);
    if (match.path === "manifest.json") folder.manifestAt = lastModified;
    const file = /^flake-records\/(?:(?<suite>[^/]+)\/)?(?<name>[^/]+)$/u.exec(match.path!)?.groups;
    if (!file) continue;
    const suite = file.suite || "unit";
    const files = folder.suites.get(suite) || { recordKeys: [] };
    folder.suites.set(suite, files);
    if (file.name === "suite-summary.json") files.summaryKey = key;
    else if (file.name!.endsWith(".jsonl")) files.recordKeys.push(key);
  }
  const since = now.getTime() - recentRuns.mainDays * 24 * 60 * 60 * 1000;
  const listed = [...folders.values()]
    .flatMap(({ main, manifestAt, suites }) =>
      manifestAt && Date.parse(manifestAt) >= since
        ? [...suites].map(([suite, files]) => ({ suite, main, uploadedAt: manifestAt, ...files }))
        : [],
    )
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const seen = new Map<string, { all: number; main: number }>();
  return listed.flatMap((run) => {
    const count = seen.get(run.suite) || { all: 0, main: 0 };
    seen.set(run.suite, count);
    const newest = count.all++ < recentRuns.newest;
    const newestMain = run.main && count.main++ < recentRuns.newestMain;
    if (!newest && !run.main) return [];
    return [
      {
        suite: run.suite,
        main: run.main,
        uploadedAt: run.uploadedAt,
        newest,
        recordKeys: run.recordKeys,
        summaryKey: run.summaryKey,
        readSummary: newest || newestMain,
      },
    ];
  });
}

/**
 * One suite run from the text of its record files and, when read, its summary. A torn or invalid
 * record line is dropped, and like a record count that does not add up to the summary's, it marks
 * the summary incomplete, since the run's result can no longer be trusted as a whole. A summary
 * that does not parse leaves the run out.
 */
export function suiteRun(
  planned: { suite: string; main: boolean; uploadedAt: string; newest: boolean },
  files: { records: string[]; summary: string | undefined },
) {
  const diagnostics = new Set<string>();
  const records = files.records.flatMap((text) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          diagnostics.add("Malformed flake record");
          return [];
        }
        const parsed = FlakeRecord.safeParse(json);
        if (parsed.success) return [parsed.data];
        diagnostics.add("Malformed flake record");
        return [];
      }),
  );
  let summary: SuiteRun["summary"];
  if (files.summary) {
    try {
      summary = FlakeSuiteSummary.parse(JSON.parse(files.summary));
    } catch {
      console.warn(
        `[flake-dashboard] invalid suite-summary.json for ${planned.suite}; run skipped`,
      );
      return undefined;
    }
    if (summary.unknownFlakeCount !== records.filter((record) => record.kind === "unknown").length)
      diagnostics.add("Unknown flake records do not match the full runner result");
    if (summary.tests.length !== summary.testCount)
      diagnostics.add("Per-test results do not match the full runner test count");
    if (diagnostics.size > 0)
      summary = {
        ...summary,
        status: "incomplete",
        diagnostics: [...summary.diagnostics, ...diagnostics],
      };
  }
  return {
    suite: planned.suite,
    main: planned.main,
    uploadedAt: planned.uploadedAt,
    newest: planned.newest,
    records,
    summary,
  };
}

/**
 * The suite runs `planReads` picks from the CI bucket's last `recentRuns.mainDays` days, through
 * R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/) with the credentials
 * `uploadTestEvidence` (scripts/ci/test-evidence.ts) derives from the same Cloudflare API token.
 */
export async function readSuiteRuns(input: {
  accountId: string;
  bucketName: string;
  /** Doppler `_shared/preview`'s CLOUDFLARE_API_TOKEN, which CI uploads the evidence with. */
  apiToken: string;
  now: Date;
}) {
  const bucket = await ciBucket(input);
  const dates = Array.from({ length: recentRuns.mainDays + 1 }, (_, days) =>
    new Date(input.now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const listings = await Promise.all(
    ["main", "pr"].flatMap((trust) =>
      dates.map((date) => bucket.list(`evidence/ci/trust=${trust}/date=${date}/`)),
    ),
  );
  const planned = planReads(listings.flat(), input.now);
  const runs = await mapConcurrent(planned, 32, async (run) =>
    suiteRun(run, {
      records: await Promise.all(run.recordKeys.map((key) => bucket.get(key))),
      summary: run.readSummary && run.summaryKey ? await bucket.get(run.summaryKey) : undefined,
    }),
  );
  return runs.flatMap((run) => (run ? [run] : []));
}

/** Listing and reading the CI bucket, each request asked again when R2 itself fails it. */
async function ciBucket(input: { accountId: string; bucketName: string; apiToken: string }) {
  const client = new AwsClient({
    accessKeyId: await apiTokenId(input),
    secretAccessKey: createHash("sha256").update(input.apiToken).digest("hex"),
    service: "s3",
    region: "auto",
  });
  const origin = `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucketName}`;
  const request = (url: string, what: string) =>
    retryPlatformFailures(
      async () => {
        const response = await fetch(await client.sign(url), {
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return response.text();
        throw new HttpAnswerError(
          `R2 ${what}: HTTP ${response.status} ${await response.text()}`,
          response.status,
        );
      },
      {
        event: "flake-dashboard.platform-failure-retry",
        delaysMs: PLATFORM_FAILURE_DELAYS_MS,
        platformFailure: (error) => httpPlatformFailure(error, { what }),
      },
    );
  return {
    /** Every object under `prefix`: ListObjectsV2, a page of up to 1,000 keys at a time. */
    async list(prefix: string) {
      const objects: { key: string; lastModified: string }[] = [];
      let continuation: string | undefined;
      do {
        const url = new URL(origin);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (continuation) url.searchParams.set("continuation-token", continuation);
        const page = await request(url.toString(), `list ${prefix}`);
        for (const [, contents] of page.matchAll(/<Contents>(.*?)<\/Contents>/gsu)) {
          const key = /<Key>(.*?)<\/Key>/su.exec(contents!)?.[1];
          const lastModified = /<LastModified>(.*?)<\/LastModified>/su.exec(contents!)?.[1];
          if (key && lastModified) objects.push({ key: unescapeXml(key), lastModified });
        }
        const next = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/su.exec(page)?.[1];
        continuation = next && unescapeXml(next);
      } while (continuation);
      return objects;
    },
    get: (key: string) =>
      request(`${origin}/${key.split("/").map(encodeURIComponent).join("/")}`, `get ${key}`),
  };
}

/**
 * The API token's id, which is its S3 access key id: a user token answers `/user/tokens/verify`, an
 * account-owned one its account's (https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/).
 */
async function apiTokenId(input: { accountId: string; apiToken: string }) {
  for (const path of ["/user/tokens/verify", `/accounts/${input.accountId}/tokens/verify`]) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${input.apiToken}` },
    });
    if (response.ok)
      return z.object({ result: z.object({ id: z.string().min(1) }) }).parse(await response.json())
        .result.id;
    await response.body?.cancel();
  }
  throw new Error("CLOUDFLARE_API_TOKEN did not verify");
}

function unescapeXml(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
