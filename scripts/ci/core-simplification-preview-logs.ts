// Reads one preview deployment and the same workers on main in the dev/preview account over the
// same bounded interval. It reports category counts only: use the Workers Logs dashboard for a
// scoped inspection of any non-zero delta.
//
//   node scripts/ci/core-simplification-preview-logs.ts run \
//     --preview pr1234-a1b2c3d --from 2026-09-29T12:00:00Z --to 2026-09-29T12:15:00Z
import { createHash } from "node:crypto";
import { createCli } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { PREVIEW_DEPLOYMENT_APPS, cloudflareAccounts, previewDeployment } from "../../envs.ts";
import { dopplerSecret } from "../lib/env-context.ts";
import { readWorkersFaultWindow, type FaultReading, type LogWindow } from "./prd-fault-alarm.ts";

type FaultTotals = Record<
  "serverErrors" | "causes" | "heals" | "healEvents" | "errors" | "closeResets" | "pagers",
  number
>;

/** The preview's seven first-party workers, in the same order as main's dev/preview workers. */
export function previewWorkers(name: string): string[] {
  const deployment = previewDeployment(name);
  if (!deployment) throw new Error(`${JSON.stringify(name)} is not a preview deployment name`);
  return [
    deployment.os.workerName,
    ...PREVIEW_DEPLOYMENT_APPS.map((app) => deployment.apps[app].workerName),
  ];
}

/** The main workers on the same account as every per-commit preview. */
export const mainWorkers = ["os", ...PREVIEW_DEPLOYMENT_APPS];

/** Counts readings without emitting error messages, request URLs, ray IDs, or other log fields. */
export function faultTotals(reading: FaultReading): FaultTotals {
  const total = (rows: readonly [string, number][]) =>
    rows.reduce((sum, [, count]) => sum + count, 0);
  return {
    serverErrors: total(reading.serverErrors),
    causes: reading.causes.reduce((sum, cause) => sum + total(cause.serverErrors), 0),
    heals: total(reading.heals),
    healEvents: total(reading.healEvents),
    errors: total(reading.errors),
    closeResets: total(reading.closeResets),
    pagers: total(reading.pagers),
  };
}

/** Candidate minus matched-main totals for the same log interval. */
export function faultDelta(candidate: FaultTotals, main: FaultTotals): FaultTotals {
  return {
    serverErrors: candidate.serverErrors - main.serverErrors,
    causes: candidate.causes - main.causes,
    heals: candidate.heals - main.heals,
    healEvents: candidate.healEvents - main.healEvents,
    errors: candidate.errors - main.errors,
    closeResets: candidate.closeResets - main.closeResets,
    pagers: candidate.pagers - main.pagers,
  };
}

/** Equal totals can conceal a different error. Hashes retain group identity without log text. */
export function newErrorGroups(candidate: FaultReading, main: FaultReading) {
  const known = new Set(main.errors.map(([message]) => message));
  const groups = new Map<string, number>();
  for (const [message, count] of candidate.errors) {
    if (known.has(message)) continue;
    const hash = createHash("sha256").update(message).digest("hex");
    groups.set(hash, (groups.get(hash) ?? 0) + count);
  }
  return [...groups].map(([hash, count]) => ({ hash, count }));
}

/** Read-only preview evidence. `from` and `to` must surround actual preview exercise, not deploy time. */
export async function run(options: { preview: string; from: string; to: string }) {
  const window = parseWindow(options);
  const account = cloudflareAccounts["dev/preview"];
  const credentials = {
    accountId: account.cloudflareAccountId,
    apiToken: dopplerSecret(account.dopplerProject, account.dopplerConfig, "CLOUDFLARE_API_TOKEN"),
  };
  const candidateWorkers = previewWorkers(options.preview);
  const [candidate, main] = await Promise.all([
    readWorkersFaultWindow(window, credentials, candidateWorkers),
    readWorkersFaultWindow(window, credentials, mainWorkers),
  ]);
  const result = {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    preview: {
      deployment: options.preview,
      workers: candidateWorkers,
      totals: faultTotals(candidate),
    },
    main: { workers: mainWorkers, totals: faultTotals(main) },
    delta: faultDelta(faultTotals(candidate), faultTotals(main)),
    newErrorGroups: newErrorGroups(candidate, main),
  };
  console.log(JSON.stringify(result));
  return result;
}

function parseWindow(options: { from: string; to: string }): LogWindow {
  const from = new Date(options.from);
  const to = new Date(options.to);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from >= to)
    throw new Error("--from and --to must be ISO timestamps with from before to");
  return { from, to };
}

if (isMainModule(import.meta.url))
  void createCli({ ...import.meta, name: "core-simplification-preview-logs" }).run();
