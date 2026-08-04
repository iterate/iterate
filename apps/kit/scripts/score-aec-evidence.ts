import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { scoreRetainedAecReleaseEvidence } from "../src/device/aec-release-retained-evidence.ts";
import { scoreRetainedAecEvidence } from "../src/device/aec-retained-evidence.ts";

const argumentsAfterScript = process.argv.slice(2);
if (argumentsAfterScript[0] === "--") argumentsAfterScript.shift();
const runDirectoryArgument = argumentsAfterScript[0];
if (!runDirectoryArgument || runDirectoryArgument === "--help") {
  console.log("Usage: pnpm aec:score -- <retained-run-directory>");
  process.exit(runDirectoryArgument === "--help" ? 0 : 2);
}
if (argumentsAfterScript.length > 1) {
  throw new Error("aec:score accepts exactly one retained run directory.");
}

const runDirectory = resolve(runDirectoryArgument);
const rawManifest: unknown = JSON.parse(
  await readFile(join(runDirectory, "manifest.json"), "utf8"),
);
const manifestVersion = z
  .looseObject({ schemaVersion: z.number().int().positive() })
  .parse(rawManifest);
const score =
  manifestVersion.schemaVersion === 2
    ? await scoreRetainedAecReleaseEvidence(runDirectory)
    : await scoreRetainedAecEvidence(runDirectory);
const outputPath = join(runDirectory, "aec-offline-assessment.json");
/*
 * Always retain the recomputed verdict beside its exact hashed inputs. A CLI
 * result that exists only in scrollback cannot be compared with a later DSP
 * build, and silently overwriting acquisition artifacts would erase the
 * distinction between what happened live and what a newer oracle concluded.
 */
await writeFile(outputPath, `${JSON.stringify(score, null, 2)}\n`);
if ("completion" in score) {
  console.log(
    JSON.stringify(
      {
        accepted: score.completion.accepted,
        device: score.device,
        dsp: score.completion.dsp,
        network: score.completion.network,
        outputPath,
      },
      null,
      2,
    ),
  );
  process.exitCode = score.completion.accepted ? 0 : 1;
} else {
  console.log(
    JSON.stringify(
      {
        device: score.device,
        deviceSignalPassed: score.deviceSignal.assessment.passed,
        outputPath,
        passed: score.passed,
        pcmTransportPassed: score.pcmTransport.assessment.passed,
        rawMicrophoneDiagnosticPassed: score.rawMicrophone.assessment.passed,
        reasons: {
          deviceSignal: score.deviceSignal.assessment.reasons,
          pcmTransport: score.pcmTransport.assessment.reasons,
          rawMicrophone: score.rawMicrophone.assessment.reasons,
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = score.passed ? 0 : 1;
}
