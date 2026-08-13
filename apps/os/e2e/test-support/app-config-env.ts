export function stripInheritedAppConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (key === "APP_CONFIG" || key.startsWith("APP_CONFIG_")) continue;
    if (value) next[key] = value;
  }

  return next;
}
