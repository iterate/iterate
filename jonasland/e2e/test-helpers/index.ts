export {
  type DeploymentRuntime,
  type Deployment,
  type DeploymentConfig,
  type DeploymentFactory,
  type DeploymentStartParams,
  type ProviderName,
  DockerDeployment,
  FlyDeployment,
  waitForHttpOk,
} from "@iterate-com/shared/jonasland/deployment";

export {
  MockEgressProxy,
  mockEgressProxy,
  type MockEgressRecord,
  type MockEgressWaitForHandle,
} from "./mock-egress-proxy.ts";
export { mockttpFixture } from "./mockttp-fixture.ts";
export { startFlyFrpEgressBridge, type FlyFrpEgressBridge } from "./frp-egress-bridge.ts";
