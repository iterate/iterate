import { createDaytonaProvider } from "./daytona.ts";
import { createLocalDockerProvider } from "./local-docker.ts";
import type { SandboxProvider } from "./types.ts";

export function getProviders(): SandboxProvider[] {
  const providers: SandboxProvider[] = [];

  if (process.env.RUN_LOCAL_DOCKER_TESTS === "true") {
    providers.push(createLocalDockerProvider());
  }

  if (process.env.RUN_DAYTONA_TESTS === "true") {
    const snapshotName = process.env.DAYTONA_SNAPSHOT_NAME;
    if (!snapshotName) {
      throw new Error("DAYTONA_SNAPSHOT_NAME required for Daytona tests");
    }
    providers.push(createDaytonaProvider({ snapshotName }));
  }

  return providers;
}

export function getProvider(): SandboxProvider {
  const providers = getProviders();
  if (providers.length === 0) {
    throw new Error("Set RUN_LOCAL_DOCKER_TESTS=true or RUN_DAYTONA_TESTS=true");
  }
  if (providers.length > 1) {
    throw new Error("Set only one of RUN_LOCAL_DOCKER_TESTS or RUN_DAYTONA_TESTS");
  }
  return providers[0];
}

export function forEachProvider<T>(testFn: (provider: SandboxProvider) => T): T[] {
  return getProviders().map(testFn);
}
