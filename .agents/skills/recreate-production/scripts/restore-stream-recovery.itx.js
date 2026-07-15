// Run from apps/os with `pnpm cli itx run --file ... --vars ...`.
// The itx CLI evaluates this body locally, so the sensitive recovery payload
// is read from the operator's mode-0700 package and sent only to the selected
// admin recovery target. Only the small restore summary is printed.

const fs = process.getBuiltinModule("node:fs");

const inputFile = String(vars.inputFile ?? "").trim();
if (!inputFile) throw new Error("vars.inputFile is required");

const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
if (input?.format !== "iterate-stream-recovery" || input?.version !== 1) {
  throw new Error("inputFile is not an Iterate stream recovery payload");
}
if (
  !input.stream ||
  (input.stream.projectId !== null &&
    (typeof input.stream.projectId !== "string" || !input.stream.projectId.trim())) ||
  typeof input.stream.path !== "string" ||
  !input.stream.path.startsWith("/")
) {
  throw new Error("inputFile has an invalid stream coordinate");
}

const recovery = itx.streamRecovery.get(input.stream);
try {
  const result = await recovery.restoreFromRecovery(input);
  return { inputFile, stream: input.stream, ...result };
} finally {
  recovery[Symbol.dispose]?.();
}
