#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
COUNT="${COUNT:-24}"

if [[ -z "${BASE_URL}" ]]; then
  echo "usage: BASE_URL=https://<worker> bash run.sh"
  echo "   or: bash run.sh https://<worker>"
  exit 2
fi

node --input-type=module - "${BASE_URL%/}" "${COUNT}" <<'NODE'
const [baseUrl, countRaw] = process.argv.slice(2);
const count = Number.parseInt(countRaw, 10);

async function call(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON status=${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function hasConcurrentDynamicWorkerError(body) {
  return body.errorSummary?.some((entry) =>
    String(entry.message).includes("Too many concurrent dynamic workers"),
  );
}

function printResult(label, body) {
  const summary = body.errorSummary?.length
    ? body.errorSummary.map((entry) => `${entry.count}x ${entry.message}`).join("; ")
    : "none";
  console.log(
    `${label}: success=${body.successCount}/${body.count} errors=${body.errorCount} elapsed=${body.elapsedMs}ms`,
  );
  console.log(`  error summary: ${summary}`);
}

let failed = false;

const control = await call(`/same-source-get?count=${count}`);
printResult("same-source-get control", control);
if (control.errorCount === 0) {
  console.log("PASS same-source-get control succeeded");
} else {
  console.log("FAIL same-source-get control had errors");
  failed = true;
}

const distinct = await call(`/distinct?count=${count}`);
printResult("distinct-source load repro", distinct);
if (hasConcurrentDynamicWorkerError(distinct)) {
  console.log("PASS repro observed: distinct concurrent sources hit Too many concurrent dynamic workers");
} else {
  console.log("FAIL repro not observed: distinct concurrent sources did not report the expected error");
  failed = true;
}

process.exit(failed ? 1 : 0);
NODE
