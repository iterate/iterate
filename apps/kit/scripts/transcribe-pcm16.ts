import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribePcm16WithXaiBatchStt } from "../src/device/xai-batch-stt.ts";

interface Options {
  endSample?: number;
  input: string;
  output?: string;
  sampleRateHz: number;
  startSample: number;
  xaiApiKey: string;
}

/**
 * Small operator-facing wrapper around the same independent oracle used by
 * the physical proof. Keeping one STT implementation matters: an ad-hoc local
 * transcription command with different file-decoding semantics could
 * disagree with the automated verdict and make a failed audio interval harder
 * to attribute.
 */
export async function transcribePcm16(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const options = parseOptions(args, environment);
  const artifact = await readFile(options.input);
  if (artifact.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("The input must be complete mono PCM16LE samples.");
  }
  const availableSamples = artifact.byteLength / Int16Array.BYTES_PER_ELEMENT;
  const endSample = options.endSample ?? availableSamples;
  if (options.startSample >= endSample || endSample > availableSamples) {
    throw new Error(
      `The requested sample interval [${options.startSample}, ${endSample}) is outside ` +
        `${availableSamples} available samples.`,
    );
  }
  const result = await transcribePcm16WithXaiBatchStt({
    apiKey: options.xaiApiKey,
    pcm: artifact.subarray(
      options.startSample * Int16Array.BYTES_PER_ELEMENT,
      endSample * Int16Array.BYTES_PER_ELEMENT,
    ),
    sampleRateHz: options.sampleRateHz,
  });
  const output = `${JSON.stringify(
    {
      input: options.input,
      interval: { endSample, startSample: options.startSample },
      result,
      sampleRateHz: options.sampleRateHz,
      schemaVersion: 1,
    },
    null,
    2,
  )}\n`;
  if (options.output) await writeFile(options.output, output, { flag: "wx" });
  else process.stdout.write(output);
}

function parseOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Options {
  let input = "";
  let output: string | undefined;
  let sampleRateHz = 48_000;
  let startSample = 0;
  let endSample: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    const value = () => {
      const selected = args[++index]?.trim();
      if (!selected) throw new Error(`${flag} requires a value.`);
      return selected;
    };
    if (flag === "--input") input = value();
    else if (flag === "--output") output = value();
    else if (flag === "--sample-rate") sampleRateHz = positiveInteger(value(), flag);
    else if (flag === "--start-sample") startSample = nonnegativeInteger(value(), flag);
    else if (flag === "--end-sample") endSample = positiveInteger(value(), flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!input) throw new Error("--input is required.");
  const xaiApiKey = environment.XAI_API_KEY?.trim() ?? "";
  if (!xaiApiKey) throw new Error("XAI_API_KEY is required.");
  return { endSample, input, output, sampleRateHz, startSample, xaiApiKey };
}

function nonnegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a nonnegative integer.`);
  }
  return parsed;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = nonnegativeInteger(value, flag);
  if (parsed === 0) throw new Error(`${flag} must be greater than zero.`);
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await transcribePcm16(process.argv.slice(2), process.env);
}
