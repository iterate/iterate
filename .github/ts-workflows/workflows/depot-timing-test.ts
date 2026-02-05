import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Minimal test workflow to measure Depot build timing.
 *
 * Tests two approaches:
 * 1. depot build --load (transfers ~2GB image to runner)
 * 2. depot build --push (pushes to registry, no local transfer)
 *
 * This helps determine if eliminating --load speeds things up.
 */
export default workflow({
  name: "Depot Timing Test",
  permissions: {
    contents: "read",
    packages: "write", // For GHCR push
    "id-token": "write", // For Depot OIDC
  },
  on: {
    workflow_dispatch: {},
  },
  jobs: {
    // Test 1: Build with --load (current approach)
    "test-with-load": {
      // Use Depot runner (same network as builders)
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}",
      steps: [
        {
          name: "Checkout",
          ...uses("actions/checkout@v4", {}),
        },
        ...utils.setupDepot,
        {
          name: "Build minimal image with --load",
          run: [
            "echo 'FROM alpine:3.20' > /tmp/Dockerfile",
            "echo 'RUN apk add --no-cache curl jq' >> /tmp/Dockerfile",
            "echo 'RUN dd if=/dev/zero of=/bigfile bs=1M count=500' >> /tmp/Dockerfile", // 500MB file to simulate size
            "",
            "echo '=== Starting build with --load ==='",
            "START=$(date +%s)",
            "depot build -f /tmp/Dockerfile --load -t test-image:load /tmp",
            "END=$(date +%s)",
            'echo "Build with --load took $((END-START)) seconds"',
            "",
            "docker images test-image:load",
          ].join("\n"),
        },
      ],
    },
    // Test 2: Build with --push (no local transfer)
    "test-with-push": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}",
      steps: [
        {
          name: "Checkout",
          ...uses("actions/checkout@v4", {}),
        },
        ...utils.setupDepot,
        {
          name: "Login to GHCR",
          ...uses("docker/login-action@v3", {
            registry: "ghcr.io",
            username: "${{ github.actor }}",
            password: "${{ secrets.GITHUB_TOKEN }}",
          }),
        },
        {
          name: "Build minimal image with --push",
          run: [
            "echo 'FROM alpine:3.20' > /tmp/Dockerfile",
            "echo 'RUN apk add --no-cache curl jq' >> /tmp/Dockerfile",
            "echo 'RUN dd if=/dev/zero of=/bigfile bs=1M count=500' >> /tmp/Dockerfile", // 500MB file
            "",
            "IMAGE=ghcr.io/${{ github.repository }}/depot-test:${{ github.sha }}",
            "",
            "echo '=== Starting build with --push ==='",
            "START=$(date +%s)",
            "depot build -f /tmp/Dockerfile --push -t $IMAGE /tmp",
            "END=$(date +%s)",
            'echo "Build with --push took $((END-START)) seconds"',
          ].join("\n"),
        },
      ],
    },
    // Test 3: Fully cached build with --load (real-world scenario)
    "test-cached-load": {
      needs: ["test-with-load"],
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}",
      steps: [
        {
          name: "Checkout",
          ...uses("actions/checkout@v4", {}),
        },
        ...utils.setupDepot,
        {
          name: "Build CACHED image with --load",
          run: [
            "echo 'FROM alpine:3.20' > /tmp/Dockerfile",
            "echo 'RUN apk add --no-cache curl jq' >> /tmp/Dockerfile",
            "echo 'RUN dd if=/dev/zero of=/bigfile bs=1M count=500' >> /tmp/Dockerfile",
            "",
            "echo '=== Starting CACHED build with --load ==='",
            "START=$(date +%s)",
            "depot build -f /tmp/Dockerfile --load -t test-image:load /tmp",
            "END=$(date +%s)",
            'echo "CACHED build with --load took $((END-START)) seconds"',
            "",
            "docker images test-image:load",
          ].join("\n"),
        },
      ],
    },
    // Test 4: Fully cached build with --push
    "test-cached-push": {
      needs: ["test-with-push"],
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04' || 'ubuntu-24.04' }}",
      steps: [
        {
          name: "Checkout",
          ...uses("actions/checkout@v4", {}),
        },
        ...utils.setupDepot,
        {
          name: "Login to GHCR",
          ...uses("docker/login-action@v3", {
            registry: "ghcr.io",
            username: "${{ github.actor }}",
            password: "${{ secrets.GITHUB_TOKEN }}",
          }),
        },
        {
          name: "Build CACHED image with --push",
          run: [
            "echo 'FROM alpine:3.20' > /tmp/Dockerfile",
            "echo 'RUN apk add --no-cache curl jq' >> /tmp/Dockerfile",
            "echo 'RUN dd if=/dev/zero of=/bigfile bs=1M count=500' >> /tmp/Dockerfile",
            "",
            "IMAGE=ghcr.io/${{ github.repository }}/depot-test:${{ github.sha }}",
            "",
            "echo '=== Starting CACHED build with --push ==='",
            "START=$(date +%s)",
            "depot build -f /tmp/Dockerfile --push -t $IMAGE /tmp",
            "END=$(date +%s)",
            'echo "CACHED build with --push took $((END-START)) seconds"',
          ].join("\n"),
        },
      ],
    },
  },
});
