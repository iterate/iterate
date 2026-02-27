import type { CloudflareEnv } from "../../env.ts";

export const PROJECT_SANDBOX_PROVIDER = ["fly", "docker", "daytona"] as const;
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
  const daytonaEnabled = isEnabled(env.SANDBOX_DAYTONA_ENABLED, false);
  const dockerEnabled = isEnabled(env.SANDBOX_DOCKER_ENABLED, false);
  const flyEnabled = isEnabled(env.SANDBOX_FLY_ENABLED, true);
  const hasSandboxNamePrefix = Boolean(env.SANDBOX_NAME_PREFIX);
  const namingDisabledReason = hasSandboxNamePrefix ? undefined : "SANDBOX_NAME_PREFIX not set";

  if (flyEnabled) {
    const hasFlyToken = Boolean(env.FLY_API_TOKEN);
    const disabledReason = !hasFlyToken
      ? "FLY_API_TOKEN not set"
      : !hasSandboxNamePrefix
        ? "SANDBOX_NAME_PREFIX not set"
        : undefined;
    options.push({
      type: "fly",
      label: "Fly.io",
      disabledReason,
    });
  }

  if (dockerEnabled) {
    options.push({
      type: "docker",
      label: "Docker",
      disabledReason: !isDev
        ? "Docker provider only available in development"
        : namingDisabledReason,
    });
  }

  if (daytonaEnabled) {
    options.push({
      type: "daytona",
      label: "Daytona (Cloud)",
      disabledReason: namingDisabledReason,
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

  if (availableProviders.includes("fly")) {
    return "fly";
  }

  if (availableProviders.includes("docker")) {
    return "docker";
  }

  if (availableProviders.includes("daytona")) {
    return "daytona";
  }

  return availableProviders[0] ?? "fly";
}
