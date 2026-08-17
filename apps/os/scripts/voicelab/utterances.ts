// The things an unattended driver says, synthesised on demand.
//
//   doppler run --config preview_3 -- pnpm cli voicelab utterances
//
// GENERATED RATHER THAN COMMITTED. These are six hundred kilobytes of WAV that
// one line of `say` reproduces exactly, and a binary in the tree is a thing
// that drifts from the sentence somebody meant to test. What is worth keeping
// under review is the WORDS, which are right here in the source.
//
// WHY THESE SENTENCES. Every one of them asks for a LONG answer, because the
// failures this lab keeps finding are failures of duration: a pacer that
// overflows the device's buffer, a queue discarded by a re-dial, a delta whose
// tail is dropped. A short answer exercises none of it. Counting leads because
// a monotonic sequence spoken aloud is the one answer whose gaps a human ear
// can hear unaided — every audio bug here has been caught with it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** What the driver says, in the order it rotates through them. */
const UTTERANCES: { name: string; text: string }[] = [
  {
    name: "01-count",
    text: "Please count out loud slowly from one to one hundred. One number per second. Do not stop early.",
  },
  {
    name: "02-story",
    text: "Tell me a long detailed story about a lighthouse keeper who collects stamps. Take at least two minutes.",
  },
  {
    name: "03-explain",
    text: "Explain in detail how a tide works, and then explain how a clock works.",
  },
  {
    name: "04-count-again",
    text: "Now count backwards from fifty to one, slowly and clearly.",
  },
];

/**
 * The format the host CLI's WAV reader takes, and the boards' sample rate.
 *
 * Not negotiable and not guessed: 16 kHz mono PCM16 is what the whole pipe
 * carries, and a file at any other rate is played at the wrong speed by
 * something downstream that will not say so.
 */
const SAY_FORMAT = "LEI16@16000";

/** Options for `pnpm cli voicelab utterances`. */
export interface UtterancesOptions {
  /** Where to write them. Defaults to this directory's `utterances/`. */
  dir?: string;
  /** A macOS voice name, for example Samantha. */
  voice?: string;
  /** Rewrite files that already exist. */
  force?: boolean;
}

export function utterances(options: UtterancesOptions = {}) {
  const dir = options.dir ?? new URL("./utterances", import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  for (const utterance of UTTERANCES) {
    const file = path.join(dir, `${utterance.name}.wav`);
    if (options.force !== true && fs.existsSync(file)) {
      console.log(`kept    ${file}`);
      continue;
    }
    execFileSync("say", [
      ...(options.voice === undefined ? [] : ["-v", options.voice]),
      "-o",
      file,
      "--data-format",
      SAY_FORMAT,
      "--channels=1",
      utterance.text,
    ]);
    console.log(`wrote   ${file}`);
  }
  console.log(`\n  pass this to a driver:\n    --utterance-dir ${dir}\n`);
}
