import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Build sandbox Docker image and run local Docker tests.
 *
 * Build and test must run in the same job because tests need
 * the image in the local Docker daemon (can't share between jobs).
 *
 * Can be triggered:
 * - Automatically on push/PR to main with relevant path changes
 * - Manually via workflow_dispatch to test any commit
 * - Called by other workflows via workflow_call
 */
export default workflow({
  name: "Local Docker Tests",
  permissions: {
    contents: "read",
    "id-token": "write", // Required for Depot OIDC authentication
  },
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {},
    // Directly invokable for testing any commit
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description:
            "Build platform (linux/amd64 or linux/arm64). Auto-detects from runner if empty.",
          required: false,
          type: "string",
          default: "",
        },
        image_name: {
          description: "Docker image name/tag to use",
          required: false,
          type: "string",
          default: "iterate-sandbox:test",
        },
      },
    },
    // Callable by other workflows
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Uses workflow ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        docker_platform: {
          description:
            "Build platform (linux/amd64 or linux/arm64). Auto-detects from runner if empty.",
          required: false,
          type: "string",
          default: "",
        },
        image_name: {
          description: "Docker image name/tag to use",
          required: false,
          type: "string",
          default: "iterate-sandbox:test",
        },
      },
      outputs: {
        test_result: {
          description: "Test result (success or failure)",
          value: "${{ jobs.build-and-test.outputs.test_result }}",
        },
      },
    },
  },
  jobs: {
    "build-and-test": {
      // Container build/test workflow should run on Depot builders.
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        test_result: "${{ steps.test.outcome }}",
      },
      steps: [
        // Checkout with configurable ref
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
        },
        // Setup pnpm
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
        // Setup Doppler
        ...utils.setupDoppler({ config: "dev" }),
        // Setup Depot CLI
        ...utils.setupDepot,
        // Build image
        {
          name: "Build Docker image",
          env: {
            LOCAL_DOCKER_IMAGE_NAME: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            SANDBOX_BUILD_PLATFORM:
              "${{ inputs.docker_platform || (runner.arch == 'ARM64' && 'linux/arm64' || 'linux/amd64') }}",
            // Avoid builder -> runner --load transfer: save image to Depot Registry first.
            SANDBOX_USE_DEPOT_REGISTRY: "true",
            SANDBOX_DEPOT_SAVE_TAG:
              "iterate-sandbox-test-${{ github.run_id }}-${{ github.run_attempt }}",
          },
          run: [
            "echo '::group::Build timing'",
            "time pnpm os docker:build",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        // Pull saved image from Depot Registry into local Docker daemon for test execution.
        {
          name: "Pull Docker image from Depot Registry",
          env: {
            IMAGE_NAME: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            PULL_PLATFORM:
              "${{ inputs.docker_platform || (runner.arch == 'ARM64' && 'linux/arm64' || 'linux/amd64') }}",
          },
          run: [
            "echo '::group::Pull timing'",
            'build_info_path=".cache/depot-build-info.json"',
            'depot_project_id="$(jq -r \'.depotProjectId\' "$build_info_path")"',
            'depot_save_tag="$(jq -r \'.depotSaveTag\' "$build_info_path")"',
            'image_ref="$(jq -r \'.depotRegistryImageName\' "$build_info_path")"',
            'if [ "$depot_project_id" = "null" ] || [ "$depot_save_tag" = "null" ] || [ "$image_ref" = "null" ]; then',
            '  echo "Missing Depot registry metadata in $build_info_path" >&2',
            "  exit 1",
            "fi",
            'time depot pull --platform "$PULL_PLATFORM" --project "$depot_project_id" "$depot_save_tag"',
            'docker image inspect "$image_ref" > /dev/null',
            'docker tag "$image_ref" "$IMAGE_NAME"',
            "echo 'Pulled image: $image_ref'",
            "echo '::endgroup::'",
          ].join("\n"),
        },
        // Run tests
        {
          id: "test",
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            LOCAL_DOCKER_IMAGE_NAME: "${{ inputs.image_name || 'iterate-sandbox:test' }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
          run: "pnpm os docker:test",
        },
        // Upload test artifacts on failure
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "local-docker-test-logs",
            path: "apps/os/sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
