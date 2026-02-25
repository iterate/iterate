export const checkoutRefExpression =
  "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}";

const jonaslandPaths = [
  "jonasland/e2e/**",
  "jonasland/sandbox/**",
  "services/events-service/**",
  "services/orders-service/**",
  "services/docs-service/**",
  "services/outerbase-service/**",
  "services/home-service/**",
  "services/egress-service/**",
  "services/registry-service/**",
  "packages/pidnap/**",
] as const;

const workflowPaths = [
  ".github/workflows/e2e-tests.yml",
  ".github/workflows/e2e-specs.yml",
  ".github/workflows/jonasland-sandbox-image.yml",
  ".github/ts-workflows/workflows/e2e-tests.ts",
  ".github/ts-workflows/workflows/e2e-specs.ts",
  ".github/ts-workflows/workflows/jonasland-sandbox-image.ts",
  ".github/ts-workflows/workflows/jonasland/**",
] as const;

export const jonaslandTriggerPaths = [...jonaslandPaths, ...workflowPaths] as const;
