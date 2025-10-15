/**
export async function getSecret<CloudflareEnv, T extends keyof CloudflareEnv>(
 * Get a secret from the environment, the secret might be present as a string or as a getter depending on the environment this handles both
 * @param env - The environment
 * @param key - The key of the secret
 * @returns The secret
 */
export async function getSecret<CloudflareEnv, T extends keyof CloudflareEnv & string>(
  env: CloudflareEnv,
  key: CloudflareEnv[T] extends string
    ? T
    : CloudflareEnv[T] extends { get: () => Promise<string> }
      ? T
      : never,
): Promise<string> {
  const secret = env[key] as string | { get: () => Promise<string> } | undefined;
  if (typeof secret === "string") {
    return secret;
  }

  if (!secret) {
    throw new Error(`Binding ${key} is missing from env`);
  }
  if ("get" in secret) {
    const secretValue = await secret.get();
    return secretValue as string;
  }
  throw new Error(`Secret ${key} is not a string or a function that returns a string`);
}
