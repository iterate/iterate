// The production Apple renderer/writer can be exercised on macOS without Xcode
// or a camera. iPhone compilation still belongs to the EAS preview build.
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
(async () => {
  if (process.platform !== "darwin")
    throw new Error("Native filter proof needs macOS Apple frameworks");
  const directory = mkdtempSync(path.join(tmpdir(), "iterate-native-filter-test-"));
  const runtime = path.join(directory, "filters.js");
  writeFileSync(runtime, await require("./build-native-filters.cjs")());
  const root = path.resolve(__dirname, "..");
  const sources = ["FilterCanvas", "FilterMovieWriter", "FilterRenderer", "FilterPitch"].map(
    (name) => path.join(root, "modules/filter-camera/ios", `${name}.swift`),
  );
  const binary = path.join(directory, "proof");
  execFileSync(
    "swiftc",
    [
      "-parse-as-library",
      ...sources,
      path.join(root, "modules/filter-camera/tests/RecordingProof.swift"),
      "-o",
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync(binary, [runtime, ...process.argv.slice(2)], { stdio: "inherit", timeout: 120_000 });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
