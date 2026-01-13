import type { Step, Workflow } from "@jlarky/gha-ts/workflow-types";

export * from "./github-script.ts";

export const prTriggerable = {
  on: {} satisfies Workflow["on"],
};

export const runsOn = {
  "runs-on": `\${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}`,
};

/** use this instead of `runsOn` if you want fast startup time instead of fast cache restore time */
export const runsOnUbuntuLatest = {
  "runs-on": "ubuntu-latest",
};

/** checkout, setup pnpm, setup node, install dependencies */
export const setupRepo = [
  {
    name: "Checkout code",
    uses: "actions/checkout@v4",
  },
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
