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

    cd apps/os

    echo '
      import * as fs from 'fs';
      const waitFor = process.argv[2];
      const timeoutSeconds = Number(process.argv[3]);

      for (let i = 0; i < timeoutSeconds; i++) {
        if (fs.existsSync(waitFor)) {
          console.log(\`\${waitFor} exists\`);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(\`\${waitFor} not found yet, retrying \${i + 1}/\${timeoutSeconds}\`);
      }
      throw new Error(\`\${waitFor} not found after \${timeoutSeconds} seconds\`);
    ' > wait-for-file.mjs

    echo '
      const main = async () => {
        const waitFor = process.argv[2];
        const timeoutSeconds = Number(process.argv[3]);
        for (let i = 0; i < timeoutSeconds; i++) {
          try {
            const res = await fetch(waitFor);
            if (!res.ok) throw new Error(\`\${waitFor} not ready\`);
            console.log(\`\${waitFor} ready\`);
            return;
          } catch (error) {
            console.log(\`\${waitFor} not ready, retrying \${i + 1}/\${timeoutSeconds}\`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        throw new Error(\`\${waitFor} not ready after \${timeoutSeconds} seconds\`);
      }
      await main();
    ' > wait-for-url.mjs

    doppler run -- printenv >> .env
    echo SLACK_CLIENT_ID=fake >> .env

    SLACK_CLIENT_ID=fake doppler run -- pnpm dev &
    DEV_PID=\$!

    SLACK_CLIENT_ID=fake doppler run -- pnpm build &
    BUILD_PID=\$!

    node wait-for-file.mjs "$(pwd)/.alchemy/local/wrangler.jsonc" 240
    # kill dev process
    kill -9 \$DEV_PID

    wait

    SLACK_CLIENT_ID=fake doppler run -- pnpm preview &

    node wait-for-url.mjs "http://localhost:5173" 240
  `,
};
