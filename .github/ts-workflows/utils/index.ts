import { uses, type Step, type Workflow } from "@jlarky/gha-ts/workflow-types";

export * from "./github-script.ts";

export const prTriggerable = {
  on: {} satisfies Workflow["on"],
};
export const runsOn = {
  "runs-on": `\${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}`,
};

/** use this for jobs that don't need ARM - still uses Depot for speed */
export const runsOnUbuntuLatest = {
  "runs-on": `\${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}`,
};

/** checkout, setup pnpm, setup node, install dependencies */
export const setupRepo = [
  {
    name: "Checkout code",
    ...uses("actions/checkout@v4", {
      // Use PR head SHA instead of synthetic merge commit for better cache hits
      ref: "${{ github.event.pull_request.head.sha || github.sha }}",
    }),
  },
  // Note: Doppler CLI is installed by setupDoppler - don't duplicate here
  {
    name: "Setup pnpm",
    uses: "pnpm/action-setup@v4",
  },
  {
    name: "Setup Node",
    uses: "actions/setup-node@v4",
    with: {
      "node-version": 24,
      cache: "pnpm",
    },
  },
  {
    name: "Install dependencies",
    run: "pnpm install",
  },
] as const satisfies Step[];

type DopplerConfigName = `dev_${string}` | "dev" | "stg" | "prd" | `\${{ ${string} }}`;
export const setupDoppler = ({ config }: { config: DopplerConfigName }) =>
  [
    {
      name: "Install Doppler CLI",
      uses: "dopplerhq/cli-action@v2",
    },
    {
      name: "Setup Doppler",
      run: `doppler setup --config ${config} --project os`,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
      },
    },
  ] as const satisfies Step[];

/** Install Depot CLI for Docker builds with persistent layer caching */
export const setupDepot = [
  {
    name: "Setup Depot CLI",
    uses: "depot/setup-action@v1",
  },
] as const satisfies Step[];
