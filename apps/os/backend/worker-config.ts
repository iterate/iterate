import dedent from "dedent";
import { z } from "zod/v4";

export const workerCrons = {
  /** every minute */
  processOutboxQueue: "0-59/1 * * * *",
} as const;

const uniqueCrons = new Set(Object.values(workerCrons));
if (uniqueCrons.size !== Object.values(workerCrons).length) {
  const msg = dedent`
    Duplicate cron expressions found in workerCrons: ${Object.values(workerCrons).join("\n")}

    This is banned because it makes it harder to write type-safe, obviously-correct switch statements etc.
    if you need two minute-ly crons, just use arbitrary differences like \`*/1 * * * *\` and \`0-59/1 * * * *\`
  `;
  throw new Error(msg);
}

export type WorkerCrons = typeof workerCrons;
export type WorkerCronName = keyof WorkerCrons;
export type WorkerCronExpression = WorkerCrons[WorkerCronName];

export const RegionConfig = z.object({
  /** https://developers.cloudflare.com/r2/reference/data-location/#available-hints */
  r2BucketHint: z.enum([
    "wnam", // Western North America
    "enam", // Eastern North America
    "weur", // Western Europe
    "eeur", // Eastern Europe
    "apac", // Asia Pacific
    "oc", // Oceania
  ]),
  /**
   * Cloud provider region to place your Worker closest to.
   *
   * Format: `{provider}:{region}`
   *
   * Supported providers:
   * - AWS: `aws:us-east-1`, `aws:us-west-2`, `aws:eu-central-1`, etc.
   * - GCP: `gcp:us-east4`, `gcp:europe-west1`, `gcp:asia-east1`, etc.
   * - Azure: `azure:westeurope`, `azure:eastus`, `azure:southeastasia`, etc.
   *
   * @see https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html
   * @see https://cloud.google.com/compute/docs/regions-zones
   * @see https://learn.microsoft.com/en-us/azure/reliability/regions-list
   * @see https://github.com/alchemy-run/alchemy/blob/main/alchemy/src/cloudflare/worker.ts
   *
   * @example "aws:us-east-1"
   * @example "gcp:us-east4"
   * @example "azure:westeurope"
   */
  workerPlacementRegion: z.enum([
    "aws:us-east-1", // N. Virginia
    "aws:us-west-2", // Oregon
    "aws:eu-west-1", // Dublin
    "aws:eu-west-2", // London
    // other ones not used yet omitted for now
  ]),
  /** https://docs.archil.com/reference/regions#aws-regions */
  archilRegion: z.enum([
    "aws-us-east-1", // N. Virginia
    "aws-us-west-2", // Oregon
    "aws-eu-west-1", // Dublin
    // todo: check for London soon!
    "gcp-us-central1", // Iowa
  ]),
  /** https://fly.io/docs/reference/regions/#fly-io-regions */
  flyIoRegion: z.enum([
    "ams", // Amsterdam, Netherlands
    "arn", // Stockholm, Sweden
    "bom", // Mumbai, India
    "cdg", // Paris, France
    "dfw", // Dallas, Texas (US)
    "ewr", // Secaucus, NJ (US)
    "fra", // Frankfurt, Germany
    "gru", // Sao Paulo, Brazil
    "iad", // Ashburn, Virginia (US)
    "jnb", // Johannesburg, South Africa
    "lax", // Los Angeles, California (US)
    "lhr", // London, United Kingdom
    "nrt", // Tokyo, Japan
    "ord", // Chicago, Illinois (US)
    "sin", // Singapore, Singapore
    "sjc", // San Jose, California (US)
    "syd", // Sydney, Australia
    "yyz", // Toronto, Canada
  ]),
  /** https://planetscale.com/docs/vitess/regions#aws-regions */
  planetscaleRegion: z.enum([
    // AWS regions
    "ap-northeast", // AWS ap-northeast-1 (Tokyo)
    "ap-south", // AWS ap-south-1 (Mumbai)
    "ap-southeast", // AWS ap-southeast-1 (Singapore)
    "aws-ap-southeast-2", // AWS ap-southeast-2 (Sydney)
    "aws-ca-central-1", // AWS ca-central-1 (Montreal)
    "eu-central", // AWS eu-central-1 (Frankfurt)
    "eu-west", // AWS eu-west-1 (Dublin)
    "aws-eu-west-2", // AWS eu-west-2 (London)
    "aws-sa-east-1", // AWS sa-east-1 (Sao Paulo)
    "us-east", // AWS us-east-1 (Northern Virginia)
    "aws-us-east-2", // AWS us-east-2 (Ohio)
    "us-west", // AWS us-west-2 (Oregon)
    // GCP regions
    "gcp-us-central1", // GCP us-central1 (Council Bluffs, Iowa)
    "gcp-us-east4", // GCP us-east4 (Ashburn, Virginia)
    "gcp-northamerica-northeast1", // GCP northamerica-northeast1 (Montreal)
    "gcp-asia-northeast3", // GCP asia-northeast3 (Seoul)
    "gcp-us-east1", // GCP us-east1 (Moncks Corner, South Carolina)
    "gcp-europe-west1", // GCP europe-west1 (St Ghislain, Belgium)
  ]),
});

/** Archil API keys are region-specific, so have a single env var mapping from region to API */
export const ArchilApiKeys = z.record(
  z.enum(RegionConfig.shape.archilRegion.options),
  z.string().brand("ArchilApiKey"),
);

const wrapJsonEnvVar = <Z extends z.ZodType>(schema: Z) =>
  z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid JSON: " + String(error),
        });
        return z.NEVER;
      }
    })
    .pipe(schema)
    .transform((value) => JSON.stringify(value) as jsonEnvVar.Wrapped<Z>); // re-stringify with branding

const parseJsonEnvVar = <Z extends z.ZodType>(schema: Z, stringVar: jsonEnvVar.Wrapped<Z>) => {
  // both schema.parse and JSON.parse *should* always succeed, it's already been validated, but if someone messed with types or cast to any this will catch it
  return schema.parse(JSON.parse(stringVar));
};

export const jsonEnvVar = {
  wrap: wrapJsonEnvVar,
  parse: parseJsonEnvVar,
};

// type helpers
export declare namespace jsonEnvVar {
  export type Wrapped<Z extends z.ZodType> = string & {
    $parseTarget: z.output<Z> | undefined;
  };
}
