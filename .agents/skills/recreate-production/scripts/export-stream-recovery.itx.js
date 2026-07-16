// Run from apps/os with `pnpm cli itx run --file ... --vars ...`.
// The itx CLI evaluates this body locally, so the RpcTarget below persists
// each server-pushed page before acknowledging it.

const fs = process.getBuiltinModule("node:fs");
const pathModule = process.getBuiltinModule("node:path");

const outputDir = String(vars.outputDir ?? "").trim();
const streamPath = String(vars.path ?? "").trim();
const projectId = vars.projectId;
const limit = Number(vars.limit ?? 500);
const maxPages = Number(vars.maxPages ?? 32);

if (!outputDir) throw new Error("vars.outputDir is required");
if (!streamPath.startsWith("/")) throw new Error("vars.path must be an absolute stream path");
if (projectId !== null && (typeof projectId !== "string" || !projectId.trim())) {
  throw new Error("vars.projectId must be a project ID or null");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
  throw new Error("vars.limit must be an integer from 1 to 500");
}
if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 32) {
  throw new Error("vars.maxPages must be an integer from 1 to 32");
}

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outputDir, 0o700);

const pageFiles = fs
  .readdirSync(outputDir)
  .filter((name) => /^\d{8}\.json$/.test(name))
  .sort();
let throughOffset;
let previousOffset = 0;
let totalEventCount = 0;
let alreadyComplete = false;

function validatePage(page, name) {
  if (page?.format !== "iterate-stream-recovery" || page?.version !== 1) {
    throw new Error(`${name} is not an Iterate stream recovery page`);
  }
  if (page.stream?.projectId !== projectId || page.stream?.path !== streamPath) {
    throw new Error(`${name} belongs to a different stream`);
  }
  if (!Number.isInteger(page.throughOffset) || page.throughOffset < 0) {
    throw new Error(`${name} has an invalid throughOffset`);
  }
  if (throughOffset === undefined) throughOffset = page.throughOffset;
  if (page.throughOffset !== throughOffset) {
    throw new Error(`${name} changed the fixed throughOffset`);
  }
  if (!Array.isArray(page.events)) throw new Error(`${name} has no events array`);
  for (const event of page.events) {
    if (!Number.isInteger(event?.offset) || event.offset <= previousOffset) {
      throw new Error(`${name} has a non-increasing event offset`);
    }
    previousOffset = event.offset;
  }
  totalEventCount += page.events.length;
}

for (const [index, name] of pageFiles.entries()) {
  const page = JSON.parse(fs.readFileSync(pathModule.join(outputDir, name), "utf8"));
  validatePage(page, name);
  if (page.complete && index !== pageFiles.length - 1) {
    throw new Error(`${name} is complete but later pages exist`);
  }
  if (!page.complete && page.events.length === 0) {
    throw new Error(`${name} is an empty incomplete page`);
  }
  alreadyComplete = page.complete;
}

if (alreadyComplete) {
  return {
    outputDir,
    stream: { projectId, path: streamPath },
    throughOffset,
    pageCount: pageFiles.length,
    eventCount: totalEventCount,
    resumed: true,
    alreadyComplete: true,
  };
}

let nextPageNumber = pageFiles.length + 1;
class RecoveryPageSink extends RpcTarget {
  async write(page) {
    const name = `${String(nextPageNumber).padStart(8, "0")}.json`;
    validatePage(page, name);
    const finalPath = pathModule.join(outputDir, name);
    const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(page)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporaryPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
    nextPageNumber += 1;
  }
}

const sink = new RecoveryPageSink();
let sessionCount = 0;
try {
  for (;;) {
    const sessionStartOffset = previousOffset;
    const recovery = itx.streamRecovery.get({ projectId, path: streamPath });
    let result;
    try {
      result = await recovery.exportToRecovery({
        sink,
        afterOffset: previousOffset,
        limit,
        maxPages,
        ...(throughOffset === undefined ? {} : { throughOffset }),
      });
    } finally {
      recovery[Symbol.dispose]?.();
    }
    sessionCount += 1;
    if (throughOffset !== result.throughOffset) {
      throw new Error("export result did not match the persisted throughOffset");
    }
    if (result.lastExportedOffset !== previousOffset) {
      throw new Error("export result did not match the last persisted event offset");
    }
    if (result.complete) break;
    if (previousOffset <= sessionStartOffset) {
      throw new Error("incomplete recovery export session made no progress");
    }
  }
  return {
    outputDir,
    stream: { projectId, path: streamPath },
    throughOffset,
    pageCount: nextPageNumber - 1,
    eventCount: totalEventCount,
    sessionCount,
    resumed: pageFiles.length > 0,
    alreadyComplete: false,
  };
} finally {
  sink[Symbol.dispose]?.();
}
