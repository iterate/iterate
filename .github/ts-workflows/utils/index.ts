import { uses, type Step, type Workflow } from "@jlarky/gha-ts/workflow-types";

export * from "./github-script.ts";

export const prTriggerable = {
  on: {} satisfies Workflow["on"],
};
/** Use this for ordinary GitHub Actions jobs that should run on Depot's small Linux runner. */
export const runsOnDepotUbuntu = {
  "runs-on": "depot-ubuntu-24.04",
};

/**
 * Larger Depot runner for jobs that need more headroom than ordinary CI.
 * (The preview deploy + e2e job runs on Depot CI — see
 * .depot/workflows/cloudflare-previews.yml — so this is currently unused, but
 * kept for the next heavy GitHub Actions job.)
 */
export const runsOnDepotUbuntuLarge = {
  "runs-on": "depot-ubuntu-24.04-8",
};

/** checkout, setup pnpm, setup node, install dependencies. Accepts an optional ref override (e.g. for workflow_dispatch inputs). */
export const getSetupRepo = ({ ref }: { ref?: string } = {}) =>
  [
    {
      name: "Checkout code",
      ...uses("actions/checkout@v4", {
        // Use PR head SHA instead of synthetic merge commit for better cache hits
        ref: ref ?? "${{ github.event.pull_request.head.sha || github.sha }}",
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

/** checkout, setup pnpm, setup node, install dependencies */
export const setupRepo = getSetupRepo();

export const installDopplerCli = {
  name: "Install Doppler CLI",
  run: [
    'for i in 1 2 3; do curl -sfLS https://cli.doppler.com/install.sh | sh -s -- --no-package-manager && break; echo "Attempt $i failed, retrying in 5s..."; sleep 5; done',
    "doppler --version || { echo 'Failed to install Doppler CLI after 3 attempts'; exit 1; }",
  ].join("\n"),
} as const satisfies Step;

type DopplerConfigName =
  | `dev_${string}`
  | `preview_${string}`
  | "dev"
  | "preview"
  | "prd"
  | `\${{ ${string} }}`;
export const setupDoppler = ({ config, project }: { config: DopplerConfigName; project: string }) =>
  [
    installDopplerCli,
    {
      name: "Setup Doppler",
      run: `doppler setup --config ${config} --project ${project}`,
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

/** Set an environment variable to a bash expression */
export const setEnvVar = (name: string, expression: string) =>
  ({
    name: `Set ${name} env var`,
    run: `echo "${name}=${expression}" >> $GITHUB_ENV`,
  }) satisfies Step;

export const setDopplerEnvVar = (name: string) =>
  setEnvVar(name, `$(doppler secrets get ${name} --plain)`);
