/**
 * Deploy-time template artifact seeding — retired.
 *
 * Dynamic workers now build in-workerd with `@cloudflare/worker-bundler`. That
 * package only runs inside workerd, so the host deploy process cannot prebuild
 * template artifacts with the same toolchain the runtime uses. Cold builds for
 * the simplified first-party apps are small enough that project birth and first
 * page load pay them on demand, and content-addressed keys let concurrent
 * projects share the first successful artifact.
 *
 * Kept as a named no-op so deploy.ts and any call-site docs stay a one-line
 * delete later, once operators are used to the absence of seed logs.
 */
export async function seedTemplateWorkerArtifacts(input: {
  accountId: string;
  apiToken: string;
  kvNamespaceId: string;
  iterateSdkPackageSpec: string | undefined;
  log?: (message: string) => void;
}): Promise<Array<{ buildKey: string; seeded: boolean }>> {
  void input.accountId;
  void input.apiToken;
  void input.kvNamespaceId;
  void input.iterateSdkPackageSpec;
  const log = input.log ?? console.log;
  log(
    "template worker artifact seeding skipped — dynamic workers build in-workerd via @cloudflare/worker-bundler",
  );
  return [];
}
