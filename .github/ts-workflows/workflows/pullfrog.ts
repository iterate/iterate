import { type Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Pullfrog",
  "run-name": "${{ inputs.name || github.workflow }}",
  on: {
    workflow_dispatch: {
      inputs: {
        prompt: {
          type: "string",
          description: "Agent prompt",
        },
        name: {
          type: "string",
          description: "Run name",
        },
      },
    },
  },
  permissions: {
    "id-token": "write",
    contents: "write",
    "pull-requests": "write",
    issues: "write",
    actions: "read",
    checks: "read",
  },
  jobs: {
    pullfrog: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo.map((step) => {
          if (step.name === "Checkout code") {
            step = { ...step, with: { ...step.with, "fetch-depth": 1 } };
          }
          return step;
        }),
        ...utils.setupDoppler({ config: "dev" }),
        // see https://docs.pullfrog.com/getting-started#manual-workflow-setup for more env var options - these need to be in the env for the Pullfrog action to work
        utils.setDopplerEnvVar("ANTHROPIC_API_KEY"),
        utils.setDopplerEnvVar("OPENAI_API_KEY"),
        {
          name: "Run agent",
          uses: "pullfrog/pullfrog@v0",
          with: {
            prompt: "${{ inputs.prompt }}",
          },
        },
      ],
    },
  },
} satisfies Workflow;
