import {
  isIdempotencyConflict,
  StreamProcessor,
  type EmittedInput,
  type ProcessEventArgs,
  type ReduceArgs,
} from "../../processors/index.ts";
import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type Project,
  type StreamEvent,
} from "../../sdk.ts";
import { flakeDashboardCreationEvents, flakesStreamPath } from "./app-ref.ts";
import {
  FlakeDashboardProcessorContract,
  flakeEventTypes,
  FlakeRecord,
  flakeTransitionThresholds,
  CheckRunWebhookEvent,
  type FlakeDashboardRenderResult,
  type FlakeDashboardState,
} from "./contract.ts";

const ARTIFACT_PREFIX = "flake-records-";

/**
 * Where a project's CI artifacts live. Supplied by the config worker
 * (FlakeDashboardApp.create's config) — the starter app itself carries no
 * organization identity. secretPath names a project secret holding a
 * Depot org API read token.
 */
export interface DepotIngestionConfig {
  orgId: string;
  secretPath: string;
}
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * The whole app is this worker: everything is processEvent and reduce.
 * `FlakeDashboardApp.processEvent` ingests workflow_run webhooks (CI's
 * credential-free reporting signal) into run-recorded events and wakes the
 * processor for /flakes events; `FlakeDashboardProcessor.reduce` folds them;
 * the processor's own processEvent drives the issue render and transition
 * proposals. No HTTP is served.
 */
export class FlakeDashboardApp extends StreamProcessorDurableObject<FlakeDashboardState> {
  protected readonly streamPath = flakesStreamPath;
  protected readonly recovery = true;

  protected createProcessor(deps: ProcessorHostDeps) {
    return new FlakeDashboardProcessor({
      ...deps,
      renderDashboard: async (state) => {
        using itx = await this.env.ITX.get();
        return await renderFlakeDashboardIssue(itx, state);
      },
    });
  }

  /**
   * Every flake-relevant event lands here — the same override point the
   * platform's own delivery uses (widened public so the config worker can
   * forward events over RPC). A /flakes event is a wake hint: catch-up
   * re-reads committed events from the stream and owns validation, ordering,
   * checkpointing, and dedupe.
   */
  override async processEvent(
    event: StreamEvent,
    options?: { depot?: DepotIngestionConfig },
  ): Promise<void> {
    const webhook = CheckRunWebhookEvent.safeParse(event);
    if (webhook.success) {
      if (!options?.depot) {
        // Platform-direct delivery, or a config worker mounted without CI
        // ingestion: nothing to pull from.
        return;
      }
      // Telemetry must never wedge event delivery: a throw from ingestion
      // would fail the delivery batch and retry the same poisoned webhook
      // forever, stalling every app behind it. Any failure — Depot down, an
      // unreadable zip — logs and drops this run's records.
      try {
        await this.#ingestCheckRunFlakeArtifacts(webhook.data, options.depot);
      } catch (error) {
        console.error(
          `[flake-ingest] ingestion failed for sha ${webhook.data.payload.body.check_run.head_sha} (records dropped):`,
          error,
        );
      }
      return;
    }
    if (event.path !== flakesStreamPath) return;
    const registry = await this.registry();
    await registry.catchUp("flake-dashboard");
  }

  /**
   * Artifact-pull ingestion for flake telemetry. This repo's suites run on
   * Depot CI, so a completed check_run is the signal: resolve the Depot run
   * by commit sha, list its `flake-records-<suite>` artifacts, fetch each
   * via a short-lived signed URL, and append one run-recorded event per
   * artifact to /flakes. CI holds no iterate credential; the Depot read
   * token is a platform-held project secret. Any check_run completing on the
   * same Depot run re-scans it — repeated appends dedupe on the
   * run+attempt+suite idempotency key, so redeliveries and sibling checks
   * are harmless.
   */
  async #ingestCheckRunFlakeArtifacts(
    webhook: (typeof CheckRunWebhookEvent)["_output"],
    depot: DepotIngestionConfig,
  ): Promise<void> {
    const { check_run: checkRun, repository } = webhook.payload.body;
    const params = { owner: repository.owner.login, repo: repository.name };
    using itx = await this.env.ITX.get();
    const token = await itx.secrets.get(depot.secretPath).reveal();

    const depotRpc = async <T>(method: string, body: unknown): Promise<T> => {
      const response = await fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-depot-org": depot.orgId,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`depot ${method} failed: HTTP ${response.status} ${await response.text()}`);
      }
      // Connect's JSON protocol returns the response message as a plain JSON
      // object; the assertion states which message this method returns — the
      // fields read below are checked for presence before use.
      return (await response.json()) as T;
    };

    // sha matches either the run's merge sha or its head sha, so PR-triggered
    // and push-triggered runs both resolve.
    // Connect's JSON protocol emits proto3 canonical camelCase field names
    // (verified against the live API) — snake_case reads come back undefined.
    // No run-status filter: Depot groups every workflow for a sha into one
    // run, whose status settles only after the LAST check completes — and the
    // check_run webhook for that last check arrives before the flip. A
    // finished/failed filter therefore permanently skipped the artifacts of
    // whichever check completed last (in practice the slow preview check,
    // i.e. the specs and preview-e2e suites — seen live on prd, run
    // rs7dwp1l27). A completed check's own artifacts are always uploaded
    // before its check_run event fires, so an in-progress run is safe to
    // scan; the conclusion gate already excludes cancelled/skipped checks and
    // the run+attempt+suite keys dedupe rescans.
    const runs = await depotRpc<{ runs?: { runId: string }[] }>("ListRuns", {
      repo: `${params.owner}/${params.repo}`,
      sha: checkRun.head_sha,
      pageSize: 10,
    });
    for (const run of runs.runs || []) {
      const listed = await depotRpc<{
        artifacts?: {
          artifactId: string;
          name: string;
          sizeBytes?: string | number;
          attempt?: number;
        }[];
      }>("ListArtifacts", { runId: run.runId, pageSize: 100 });
      const flakeArtifacts = (listed.artifacts || []).filter((artifact) =>
        artifact.name.startsWith(ARTIFACT_PREFIX),
      );
      if (flakeArtifacts.length === 0) continue;

      const stream = itx.streams.get(flakesStreamPath);
      // Idempotency-keyed birth: whoever ingests first births the dashboard,
      // pinned to the repository the records came from. A same-key/different-
      // body conflict also means already born — it must not abort the record
      // appends below (a poisoned birth key on prd once silently dropped
      // every CI run's records this way).
      try {
        await stream.append(
          ...flakeDashboardCreationEvents({
            repository: params,
            issueTitle: "Flake dashboard",
            defaultBranch: repository.default_branch || "main",
          }),
        );
      } catch (error) {
        if (!isIdempotencyConflict(error)) throw error;
      }

      for (const artifact of flakeArtifacts) {
        if (Number(artifact.sizeBytes || 0) > MAX_ARTIFACT_BYTES) {
          console.warn(
            `[flake-ingest] skipping oversized artifact ${artifact.name} (${artifact.sizeBytes} bytes)`,
          );
          continue;
        }
        const suite = artifact.name.slice(ARTIFACT_PREFIX.length);
        const download = await depotRpc<{ url?: string }>("GetArtifactDownloadURL", {
          artifactId: artifact.artifactId,
        });
        if (!download.url) {
          console.warn(`[flake-ingest] no download url for artifact ${artifact.name}`);
          continue;
        }
        const zipResponse = await fetch(download.url);
        if (!zipResponse.ok) {
          throw new Error(`artifact download failed: HTTP ${zipResponse.status}`);
        }
        const files = await unzip(new Uint8Array(await zipResponse.arrayBuffer()));
        const records = Object.entries(files)
          .filter(([name]) => name.endsWith(".jsonl"))
          .flatMap(([name, bytes]) =>
            new TextDecoder()
              .decode(bytes)
              .split("\n")
              .filter((line) => line.trim() !== "")
              .flatMap((line) => {
                // A torn line from a crashed test worker skips, never aborts.
                let json: unknown;
                try {
                  json = JSON.parse(line);
                } catch {
                  console.warn(
                    `[flake-ingest] skipping malformed line in ${artifact.name}/${name}`,
                  );
                  return [];
                }
                const parsed = FlakeRecord.safeParse(json);
                if (!parsed.success) {
                  console.warn(
                    `[flake-ingest] skipping malformed line in ${artifact.name}/${name}`,
                  );
                  return [];
                }
                return [parsed.data];
              }),
          );
        if (records.length === 0) continue;

        const runId = `${run.runId}-${artifact.attempt || 1}`;
        try {
          await stream.append({
            type: "events.iterate.com/flakes/run-recorded",
            idempotencyKey: `flakes/run:${runId}:${suite}`,
            payload: {
              runId,
              suite,
              branch: checkRun.check_suite?.head_branch || "unknown",
              commit: checkRun.head_sha,
              records,
            },
          });
        } catch (error) {
          // Same key, different body: the run+attempt+suite is already
          // ingested (a sibling check_run racing this one) — the first
          // committed fact wins.
          if (!isIdempotencyConflict(error)) throw error;
        }
        console.log(
          `[flake-ingest] ingested ${records.length} records from ${artifact.name} (run ${runId})`,
        );
      }
    }
  }

  /** Internal RPC surface used by smoke checks and debugging. */
  async getState(): Promise<FlakeDashboardState> {
    const registry = await this.registry();
    await registry.catchUp("flake-dashboard");
    return (await this.snapshot()).state;
  }
}

type FlakeDashboardProcessorDeps = {
  /**
   * Upsert the GitHub dashboard issue from folded state. Injected so the
   * harness tests run against a fake; the worker builds the real one over
   * itx's GitHub integration. Throwing settles the render as failed.
   */
  renderDashboard: (
    state: FlakeDashboardState,
  ) => Promise<Extract<FlakeDashboardRenderResult, { status: "succeeded" }>>;
};

/**
 * One instance runs on the project's `/flakes` stream. CI appends
 * `run-recorded` events; this processor folds them into per-test stats, owns
 * the GitHub issue render as its durable obligation, and proposes lifecycle
 * transitions when a default-branch streak crosses a threshold.
 */
export class FlakeDashboardProcessor extends StreamProcessor<
  FlakeDashboardProcessorContract,
  FlakeDashboardProcessorDeps
> {
  readonly contract = FlakeDashboardProcessorContract;

  /**
   * Runtime-only render attempt guard. The render-settled stream event is the
   * durable truth: after an eviction this is false and the next caught-up
   * pass re-drives any still-unrendered data.
   */
  #liveRender = false;

  protected override reduce({
    event,
    state,
  }: ReduceArgs<FlakeDashboardProcessorContract>): FlakeDashboardState {
    switch (event.type) {
      case flakeEventTypes.created:
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload, lastDataOffset: event.offset };

      case flakeEventTypes.runRecorded: {
        const config = state.birthCertificate?.config;
        if (config === undefined) return state;
        const onDefaultBranch = event.payload.branch === config.defaultBranch;
        const tests = { ...state.tests };
        for (const record of event.payload.records) {
          const existing = tests[record.name];
          const counts = existing?.counts || { pass: 0, flakeFail: 0, unexpectedError: 0 };
          const streak = existing?.defaultBranchStreak || null;
          const nextStreak = !onDefaultBranch
            ? streak
            : record.outcome === "unexpected-error"
              ? null
              : streak !== null && streak.outcome === record.outcome
                ? { ...streak, runs: streak.runs + 1, lastAt: record.at }
                : { outcome: record.outcome, runs: 1, firstAt: record.at, lastAt: record.at };
          tests[record.name] = {
            pattern: record.pattern,
            suites: existing?.suites.includes(event.payload.suite)
              ? existing.suites
              : [...(existing?.suites || []), event.payload.suite],
            lastSeenOffset: { ...existing?.lastSeenOffset, [event.payload.suite]: event.offset },
            recent: onDefaultBranch
              ? [...(existing?.recent || []), record.outcome].slice(-10)
              : existing?.recent || [],
            counts: {
              pass: counts.pass + (record.outcome === "pass" ? 1 : 0),
              flakeFail: counts.flakeFail + (record.outcome === "flake-fail" ? 1 : 0),
              unexpectedError:
                counts.unexpectedError + (record.outcome === "unexpected-error" ? 1 : 0),
            },
            lastFlakeAt:
              record.outcome === "flake-fail" ? record.at : existing?.lastFlakeAt || null,
            lastRecordedAt: record.at,
            defaultBranchStreak: nextStreak,
            proposed: existing?.proposed || [],
          };
        }
        const suites = onDefaultBranch
          ? {
              ...state.suites,
              [event.payload.suite]: { lastDefaultBranchRunOffset: event.offset },
            }
          : state.suites;
        return { ...state, tests, suites, lastDataOffset: event.offset };
      }

      case flakeEventTypes.transitionProposed: {
        const test = state.tests[event.payload.testName];
        if (test === undefined) return { ...state, lastDataOffset: event.offset };
        const marker = `${event.payload.transition}:${event.payload.evidence.firstAt}`;
        return {
          ...state,
          tests: {
            ...state.tests,
            [event.payload.testName]: {
              ...test,
              proposed: test.proposed.includes(marker) ? test.proposed : [...test.proposed, marker],
            },
          },
          lastDataOffset: event.offset,
        };
      }

      case flakeEventTypes.dashboardRenderSettled: {
        // Deliberately does NOT bump lastDataOffset — a settled render must
        // not itself demand another render.
        if (event.payload.result.status !== "succeeded") return state;
        return {
          ...state,
          render: {
            throughOffset: event.payload.throughOffset,
            issueNumber: event.payload.result.issueNumber,
            issueUrl: event.payload.result.issueUrl,
          },
        };
      }
    }
  }

  protected override processEvent(
    args: ProcessEventArgs<FlakeDashboardProcessorContract>,
  ): undefined {
    const { append, blockProcessorWhile, delivery, event, runInBackground, state } = args;

    // Transition proposals are short durable appends that must land before
    // the processor advances past the run that crossed the threshold.
    if (event?.type === flakeEventTypes.runRecorded) {
      for (const [testName, test] of Object.entries(state.tests)) {
        const streak = test.defaultBranchStreak;
        if (streak === null) continue;
        const transition = streak.outcome === "pass" ? "unwrap" : "switch-to-failing";
        const threshold = flakeTransitionThresholds[transition];
        const spanMs = Date.parse(streak.lastAt) - Date.parse(streak.firstAt);
        if (streak.runs < threshold.runs || spanMs < threshold.minSpanMs) continue;
        const marker = `${transition}:${streak.firstAt}`;
        if (test.proposed.includes(marker)) continue;
        blockProcessorWhile(() =>
          this.#appendTolerantOfSettledRace(append, {
            type: flakeEventTypes.transitionProposed,
            // The streak's firstAt keys the proposal: as the streak keeps
            // growing, later runs re-derive the same key with fresher
            // evidence and lose the idempotency race below — one proposal
            // per streak.
            idempotencyKey: this.idempotencyKey(`transition:${testName}:${marker}`),
            payload: {
              testName,
              transition,
              evidence: {
                consecutiveRuns: streak.runs,
                firstAt: streak.firstAt,
                lastAt: streak.lastAt,
              },
            },
          }),
        );
      }
    }

    // Behind head, newer data (or an already-settled render) may exist in an
    // unseen page; rendering from partial state would thrash the issue.
    if (!delivery.caughtUp) return;
    if (state.birthCertificate === null) return;
    if (state.lastDataOffset <= (state.render?.throughOffset || 0)) return;
    if (this.#liveRender) return;

    const throughOffset = state.lastDataOffset;
    this.#liveRender = true;
    // A dropped attempt is recovered from the still-unrendered comparison on
    // the next caught-up/revival pass; the issue upsert itself is idempotent
    // (one issue, body overwritten), so a settle-append that never landed
    // only costs one redundant render.
    runInBackground(async () => {
      let result: FlakeDashboardRenderResult;
      try {
        result = await this.deps.renderDashboard(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { status: "failed", error: message.slice(0, 8_000) || "Unknown render failure." };
      }
      try {
        await this.#appendTolerantOfSettledRace(append, {
          type: flakeEventTypes.dashboardRenderSettled,
          // The status is part of the key: a failed settlement must not claim
          // the offset's only key, or a retried render's SUCCESS at the same
          // offset would idempotency-conflict forever and the offset could
          // never be marked rendered.
          idempotencyKey: this.idempotencyKey(`dashboard-render:${throughOffset}:${result.status}`),
          payload: { throughOffset, result },
        });
      } finally {
        this.#liveRender = false;
      }
    });
  }

  /**
   * Growing streaks and overlapping render attempts can race on one
   * processor-owned key with fresher bodies. The first committed fact wins;
   * a same-key/different-body rejection means the work is already settled.
   */
  async #appendTolerantOfSettledRace(
    append: ProcessEventArgs<FlakeDashboardProcessorContract>["append"],
    event: EmittedInput<FlakeDashboardProcessorContract>,
  ): Promise<void> {
    try {
      await append(event);
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }
}

const DASHBOARD_MARKER = "<!-- iterate-flake-dashboard -->";

/**
 * Upsert the GitHub "Flake dashboard" issue from folded state. Mechanical by
 * design (the AI-linter publication stance): all decisions were made when the
 * events reduced. The processor is the single writer, so a plain body
 * overwrite is race-free; the marker plus remembered issue number make the
 * upsert idempotent across retried renders.
 */
async function renderFlakeDashboardIssue(
  itx: Project,
  state: FlakeDashboardState,
): Promise<Extract<FlakeDashboardRenderResult, { status: "succeeded" }>> {
  const config = state.birthCertificate?.config;
  if (config === undefined) throw new Error("Flake dashboard has no birth certificate.");

  const repos = await itx.repos.list();
  const links = await Promise.all(
    repos.map(async ({ path }) => (await itx.repos.get(path).processor.snapshot()).state.github),
  );
  const link = links.find(
    (candidate) =>
      candidate !== null &&
      candidate.owner === config.repository.owner &&
      candidate.repo === config.repository.repo,
  );
  if (link === null || link === undefined) {
    throw new Error(
      `No linked GitHub connection for ${config.repository.owner}/${config.repository.repo}; ` +
        "link a repo to that repository before the dashboard can render.",
    );
  }
  const octokit = itx.integrations.github.get(link.connection).octokit;
  const params = { owner: config.repository.owner, repo: config.repository.repo };
  const body = renderBody(state);

  const rememberedIssueNumber = state.render?.issueNumber || null;
  if (rememberedIssueNumber !== null) {
    const updated = await octokit.rest.issues.update({
      ...params,
      issue_number: rememberedIssueNumber,
      body,
      title: config.issueTitle,
    });
    return {
      status: "succeeded",
      issueNumber: rememberedIssueNumber,
      issueUrl: updated.data.html_url,
    };
  }

  // First render (or state predating a remembered number): find by marker
  // before creating — the marker, not the title, is authority, so a human
  // opening a same-titled issue cannot capture the dashboard.
  const issues = await octokit.paginate("GET /repos/{owner}/{repo}/issues", {
    ...params,
    state: "open",
    per_page: 100,
  });
  const existing = issues.find((issue) => issue.body?.includes(DASHBOARD_MARKER) === true);
  if (existing !== undefined) {
    await octokit.rest.issues.update({
      ...params,
      issue_number: existing.number,
      body,
      title: config.issueTitle,
    });
    return { status: "succeeded", issueNumber: existing.number, issueUrl: existing.html_url };
  }
  const created = await octokit.rest.issues.create({
    ...params,
    title: config.issueTitle,
    body,
  });
  return { status: "succeeded", issueNumber: created.data.number, issueUrl: created.data.html_url };
}

const OUTCOME_EMOJI = { pass: "🟩", "flake-fail": "🟥", "unexpected-error": "❌" } as const;

/** Exported for tests: the table is a pure projection of folded state. */
export function renderBody(state: FlakeDashboardState): string {
  const tests = Object.entries(state.tests).sort(([a], [b]) => a.localeCompare(b));
  const lastRecordedAt = tests
    .map(([, test]) => test.lastRecordedAt)
    .sort()
    .at(-1);
  // The test name is the identity: a renamed or deleted test is simply absent
  // from its suite's latest default-branch run, and its row retires. Hidden,
  // never deleted — the events stay in the log, so a transiently-absent test
  // (a crashed suite, a PR experiment) returns with full history on its next
  // record, and a genuinely retired name stays readable in the issue's edit
  // history.
  const visible = tests.filter(([, test]) =>
    Object.entries(test.lastSeenOffset).some(
      ([suite, seen]) => seen >= (state.suites[suite]?.lastDefaultBranchRunOffset || 0),
    ),
  );
  const retiredCount = tests.length - visible.length;
  const rows = visible.map(([name, test]) => {
    const gated = test.counts.pass + test.counts.flakeFail;
    const rate = gated === 0 ? "—" : `${Math.round((test.counts.flakeFail / gated) * 100)}%`;
    const streak =
      test.defaultBranchStreak === null
        ? "—"
        : `${test.defaultBranchStreak.runs}× ${test.defaultBranchStreak.outcome}`;
    return [
      `\`${name}\``,
      `\`/${test.pattern}/\``,
      test.suites.join(", "),
      String(gated + test.counts.unexpectedError),
      rate,
      test.lastFlakeAt || "never",
      test.recent.length === 0
        ? "—"
        : test.recent.map((outcome) => OUTCOME_EMOJI[outcome]).join(""),
      streak,
      test.proposed.length === 0 ? "" : test.proposed.map((p) => p.split(":")[0]).join(", "),
    ].join(" | ");
  });
  return [
    DASHBOARD_MARKER,
    "Per-test outcomes of every [`createFlake`](https://github.com/iterate/iterate/blob/main/packages/shared/src/test-support/flake-test.ts)-wrapped test, folded from CI-reported runs. Maintained automatically — edits to this body will be overwritten. Recent = last 10 default-branch outcomes, oldest→newest (🟩 pass, 🟥 flake-fail, ❌ unexpected error).",
    "",
    "test | allowed pattern | suites | runs | flake rate | last flake | recent | default-branch streak | proposed",
    "--- | --- | --- | --- | --- | --- | --- | --- | ---",
    ...(rows.length === 0 ? ["_no flake tests recorded yet_ | | | | | | | |"] : rows),
    "",
    `_Last recorded outcome: ${lastRecordedAt || "none"}._`,
    ...(retiredCount === 0
      ? []
      : [
          `_${retiredCount} retired ${retiredCount === 1 ? "test" : "tests"} hidden (no longer present in the latest default-branch run of their suite)._`,
        ]),
  ].join("\n");
}

/**
 * Minimal zip reader on the runtime's own DecompressionStream — deliberately
 * not a dependency. The format surface is narrow by construction: one
 * producer (GitHub's artifact service), a 5MB size cap upstream, and reading
 * via the central directory (sizes come from there, so streaming-writer data
 * descriptors don't matter). No zip64 — impossible under the size cap — and
 * anything unexpected throws, which ingestion treats as a logged drop.
 */
async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits at the tail, behind an optional
  // comment (max 64KB): scan backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const entryCount = view.getUint16(eocd + 10, true);
  const files: Record<string, Uint8Array> = {};
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("corrupt zip: bad central directory entry signature");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    // The local header's name/extra lengths can differ from the central
    // directory's, so the data offset comes from the local header itself.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    // slice (not subarray): a copy backed by a plain ArrayBuffer, which both
    // the DOM and Workers Response typings accept without assertions.
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 0) {
      files[name] = data;
    } else if (method === 8) {
      const inflated = new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"));
      files[name] = new Uint8Array(await new Response(inflated).arrayBuffer());
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
