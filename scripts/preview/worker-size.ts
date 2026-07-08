/**
 * Deployed worker bundle sizes, captured from wrangler's own deploy output
 * ("Total Upload: 1234.56 KiB / gzip: 345.67 KiB").
 *
 * Two producers, one consumer:
 *   - PR preview deploys parse the line out of their captured deploy output
 *     (scripts/preview/preview.ts) and record it on the PR-body table entry.
 *   - Main deploys publish the same numbers as a `worker-size/<app>` commit
 *     status on the deployed sha (scripts/ci/report-worker-size.ts, run by
 *     .depot/workflows/deploy-*.yml), which preview deploys read back as the
 *     "vs main" baseline for the size column.
 */

/** Wrangler-reported bundle size of one deployed worker, in KiB as printed. */
export interface WorkerSizeInfo {
  /** "Total Upload" — uncompressed module bytes shipped to Cloudflare. */
  totalKib: number;
  /** Gzip size — the number Cloudflare's script-size limits gate on. */
  gzipKib: number;
}

const totalUploadPattern = /Total Upload:\s*([\d,.]+)\s*KiB\s*\/\s*gzip:\s*([\d,.]+)\s*KiB/g;

/**
 * Extract the deployed worker's size from wrangler deploy output. The LAST
 * "Total Upload" line wins: a single app deploy can upload several workers
 * (os deploys its builder sidecar first, the real worker last), one line each.
 */
export function parseWorkerSizeFromDeployOutput(output: string): WorkerSizeInfo | null {
  const match = [...output.matchAll(totalUploadPattern)].at(-1);
  if (!match) {
    return null;
  }

  const totalKib = Number(match[1].replaceAll(",", ""));
  const gzipKib = Number(match[2].replaceAll(",", ""));
  if (!Number.isFinite(totalKib) || !Number.isFinite(gzipKib)) {
    return null;
  }

  return { gzipKib, totalKib };
}

/** Commit-status context main deploys publish under and previews read from. */
export function workerSizeStatusContext(appSlug: string) {
  return `worker-size/${appSlug}`;
}

/**
 * Commit-status description — human-readable on the commit's checks UI and
 * parsed back by parseWorkerSizeStatusDescription (GitHub caps it at 140
 * chars; this stays well under).
 */
export function formatWorkerSizeStatusDescription(size: WorkerSizeInfo) {
  return `gzip ${size.gzipKib} KiB / total ${size.totalKib} KiB`;
}

/** Inverse of formatWorkerSizeStatusDescription; null on any unexpected shape. */
export function parseWorkerSizeStatusDescription(
  description: string | null | undefined,
): WorkerSizeInfo | null {
  const match = description?.match(/gzip\s*([\d.]+)\s*KiB\s*\/\s*total\s*([\d.]+)\s*KiB/);
  if (!match) {
    return null;
  }

  const gzipKib = Number(match[1]);
  const totalKib = Number(match[2]);
  if (!Number.isFinite(gzipKib) || !Number.isFinite(totalKib)) {
    return null;
  }

  return { gzipKib, totalKib };
}

/** "345.7 KiB" below 1 MiB, "3.38 MiB" above — for table cells and deltas. */
export function formatKib(kib: number) {
  if (Math.abs(kib) >= 1024) {
    return `${(kib / 1024).toFixed(2)} MiB`;
  }

  return `${kib.toFixed(1)} KiB`;
}

/**
 * PR-table size cell: the deployed gzip size, plus a signed delta against
 * main's published baseline when one is known. Deltas smaller than wrangler's
 * 0.01 KiB print precision render as "±0".
 */
export function renderWorkerSizeCell(
  gzipKib: number | null | undefined,
  mainGzipKib: number | null | undefined,
) {
  if (gzipKib == null) {
    return "";
  }

  const size = formatKib(gzipKib);
  if (mainGzipKib == null) {
    return size;
  }

  const delta = gzipKib - mainGzipKib;
  if (Math.abs(delta) < 0.01) {
    return `${size} (±0 vs main)`;
  }

  return `${size} (${delta > 0 ? "+" : "-"}${formatKib(Math.abs(delta))} vs main)`;
}
