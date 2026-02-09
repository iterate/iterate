import type { CloudflareEnv } from "../../env.ts";

export const PROJECT_SANDBOX_PROVIDER = ["daytona", "docker", "fly"] as const;
export type ProjectSandboxProvider = (typeof PROJECT_SANDBOX_PROVIDER)[number];

export type SandboxProviderOption = {
  type: ProjectSandboxProvider;
  label: string;
  disabledReason?: string;
};

function isEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === "true";
}

export function getProjectSandboxProviderOptions(
  env: CloudflareEnv,
  isDev: boolean,
): SandboxProviderOption[] {
  const options: SandboxProviderOption[] = [];
  const daytonaEnabled = isEnabled(env.SANDBOX_DAYTONA_ENABLED, true);
  const dockerEnabled = isEnabled(env.SANDBOX_DOCKER_ENABLED, false);
  const flyEnabled = isEnabled(env.SANDBOX_FLY_ENABLED, false);

  if (daytonaEnabled) {
    options.push({
      type: "daytona",
      label: "Daytona (Cloud)",
      disabledReason: env.DAYTONA_SNAPSHOT_NAME ? undefined : "DAYTONA_SNAPSHOT_NAME not set",
    });
  }

  if (dockerEnabled) {
    options.push({
      type: "docker",
      label: "Docker",
      disabledReason: isDev ? undefined : "Docker provider only available in development",
    });
  }

  if (flyEnabled) {
    const hasFlyToken = Boolean(env.FLY_API_TOKEN ?? env.FLY_API_KEY);
    const hasFlyAppName = Boolean(env.SANDBOX_FLY_APP_NAME);
    const disabledReason = !hasFlyToken
      ? "FLY_API_TOKEN (or FLY_API_KEY) not set"
      : !hasFlyAppName
        ? "SANDBOX_FLY_APP_NAME not set"
        : undefined;
    options.push({
      type: "fly",
      label: "Fly.io",
      disabledReason,
    });
  }

  return options;
}

export function getAvailableProjectSandboxProviders(
  env: CloudflareEnv,
  isDev: boolean,
): ProjectSandboxProvider[] {
  return getProjectSandboxProviderOptions(env, isDev)
    .filter((option) => !option.disabledReason)
    .map((option) => option.type);
}

export function getDefaultProjectSandboxProvider(
  env: CloudflareEnv,
  isDev: boolean,
): ProjectSandboxProvider {
  const availableProviders = getAvailableProjectSandboxProviders(env, isDev);

  if (availableProviders.includes("daytona")) {
    return "daytona";
  }

  return availableProviders[0] ?? "daytona";
}
