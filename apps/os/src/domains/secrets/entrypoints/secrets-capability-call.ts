// The itx-reachable surface of the project secrets capability — pure and
// import-free so the allowlist is provable without workerd (the entrypoint
// itself needs cloudflare:workers).
//
// Owner decision (recorded): agent-writable setSecret/deleteSecret on the
// itx surface is INTENDED. The material-returning methods (getSecret,
// getSecretOrNull, getSecretSummary, deleteSecretById) are deliberately NOT
// itx-reachable: secret material only exists in the egress substitution path
// (entrypoint.ts EgressPipe); the oRPC/admin surface keeps the full method
// set for platform code.

export const ITX_SECRETS_METHODS = [
  "setSecret",
  "listSecrets",
  "deleteSecret",
  "getSecretSummaryByKey",
] as const;

export type ItxSecretsMethod = (typeof ITX_SECRETS_METHODS)[number];

/** Resolve an itx path call to an allowlisted method, or refuse with a
 * self-describing error. Only flat single-segment paths exist here. */
export function resolveItxSecretsMethod(path: string[]): ItxSecretsMethod {
  const method = path.length === 1 ? path[0] : undefined;
  if (method && (ITX_SECRETS_METHODS as readonly string[]).includes(method)) {
    return method as ItxSecretsMethod;
  }
  throw new Error(
    `itx.secrets exposes ${ITX_SECRETS_METHODS.join("/")}; secret material is never ` +
      `readable through itx — placeholders are substituted on egress` +
      (path.length > 0 ? ` (got "${path.join(".")}").` : `.`),
  );
}
