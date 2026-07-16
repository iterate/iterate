// Run locally from apps/os with `pnpm cli itx run --file ... --vars ...`.
// This uses only the ordinary public Stream read API. The resulting history is
// evidence for an operator-authored semantic recreation; it is never imported
// into a Stream Durable Object and old envelopes are never appended verbatim.

const fs = process.getBuiltinModule("node:fs");
const pathModule = process.getBuiltinModule("node:path");

const outputDir = String(vars.outputDir ?? "").trim();
const streamPath = String(vars.path ?? "").trim();
const pageLimit = Number(vars.pageLimit ?? 8);

if (!outputDir) throw new Error("vars.outputDir is required");
if (!streamPath.startsWith("/")) throw new Error("vars.path must be an absolute stream path");
// Eight maximum-sized events stay comfortably below the RPC value limit.
if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 8) {
  throw new Error("vars.pageLimit must be an integer from 1 to 8");
}

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.chmodSync(outputDir, 0o700);

const manifestPath = pathModule.join(outputDir, "manifest.json");
const stream = itx.streams.get(streamPath);
const scope = await itx.__describe();
const projectId = typeof scope.projectId === "string" ? scope.projectId : null;
let manifest;

if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest?.format !== "iterate-stream-event-export" ||
    manifest?.version !== 1 ||
    manifest?.projectId !== projectId ||
    manifest?.path !== streamPath ||
    !Number.isSafeInteger(manifest?.throughOffset) ||
    manifest.throughOffset < 0
  ) {
    throw new Error("existing manifest does not describe this stream export");
  }
} else {
  const runtime = await stream.runtimeState();
  const throughOffset = runtime?.coreProcessorState?.maxOffset;
  if (!Number.isSafeInteger(throughOffset) || throughOffset < 0) {
    throw new Error("stream runtime state did not expose a valid maxOffset");
  }
  manifest = {
    format: "iterate-stream-event-export",
    version: 1,
    projectId,
    path: streamPath,
    throughOffset,
    includeEphemeral: false,
  };
  const temporaryPath = `${manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, manifestPath);
}

const pageFiles = fs
  .readdirSync(outputDir)
  .filter((name) => /^\d{8}\.json$/.test(name))
  .sort();
let afterOffset = 0;
let eventCount = 0;

for (const [index, name] of pageFiles.entries()) {
  const expectedName = `${String(index + 1).padStart(8, "0")}.json`;
  if (name !== expectedName) {
    throw new Error(`export page sequence has a gap: expected ${expectedName}, found ${name}`);
  }
  const page = JSON.parse(fs.readFileSync(pathModule.join(outputDir, name), "utf8"));
  if (!Array.isArray(page?.events)) throw new Error(`${name} has no events array`);
  for (const event of page.events) {
    if (
      !Number.isSafeInteger(event?.offset) ||
      event.offset <= afterOffset ||
      event.offset > manifest.throughOffset ||
      event.path !== streamPath
    ) {
      throw new Error(`${name} contains an event outside this export window`);
    }
    afterOffset = event.offset;
    eventCount += 1;
  }
}

let nextPageNumber = pageFiles.length + 1;
for (;;) {
  const events = await stream.getEvents({
    afterOffset,
    beforeOffset: manifest.throughOffset + 1,
    includeEphemeral: false,
    limit: pageLimit,
  });
  if (events.length === 0) break;
  for (const event of events) {
    if (event.offset <= afterOffset || event.offset > manifest.throughOffset) {
      throw new Error("stream read returned an event outside the fixed export window");
    }
    afterOffset = event.offset;
  }
  const name = `${String(nextPageNumber).padStart(8, "0")}.json`;
  const finalPath = pathModule.join(outputDir, name);
  const temporaryPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ events }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, finalPath);
  eventCount += events.length;
  nextPageNumber += 1;
}

return {
  outputDir,
  projectId,
  path: streamPath,
  throughOffset: manifest.throughOffset,
  pageCount: nextPageNumber - 1,
  eventCount,
};
