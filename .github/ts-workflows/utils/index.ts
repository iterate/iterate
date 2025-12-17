import dedent from "dedent";
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

/**
 * Starts up the apps/os server and waits for it to be ready
 * Assumes code is checked out, node_modules are installed, and doppler is setup
 */
export const runPreviewServer = {
  name: "run preview server",
  id: "preview_server",
  run: dedent`
    # for some reason \`doppler run -- ...\` doesn't inject env vars into the server process, so write to .env
    doppler run -- printenv > apps/os/.env

    cd apps/os
    pnpm dev &

    echo '
      const main = async () => {
        const timeout = 180;
        for (let i = 0; i < timeout; i++) {
          try {
            const res = await fetch("http://localhost:5173");
            if (!res.ok) throw new Error("Preview not ready");
            console.log("Preview ready");
            return;
          } catch (error) {
            console.log(\`Preview not ready, retrying \${i + 1}/\${timeout}\`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        throw new Error("Preview not ready");
      }
      await main();
    ' > wait.mjs

    node wait.mjs

    kill -9 $(lsof -t -i:5173)

    pnpm preview &

    node wait.mjs
  `,
};
