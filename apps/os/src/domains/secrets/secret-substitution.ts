// Pure placeholder substitution for the Secret DO's fetch-with-secret. Kept
// free of cloudflare:workers imports so Node-side tests can exercise it.
//
// The placeholder is deliberately self-referential — `{{secret}}`, not
// `getSecret(key)` — because the caller already addressed ONE secret by
// dialing its DO; there is nothing to look up. (Project egress keeps the
// keyed `getSecret({ key })` convention for substituting across many secrets
// in one request; that hop can resolve each key to a Secret DO and ask it to
// substitute, which is the future unification path.)

export const SECRET_PLACEHOLDER = "{{secret}}";

export type SubstitutableRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export function substituteSecretPlaceholders(
  request: SubstitutableRequest,
  material: string,
): SubstitutableRequest {
  const substitute = (value: string) => value.split(SECRET_PLACEHOLDER).join(material);
  return {
    url: substitute(request.url),
    ...(request.method == null ? {} : { method: request.method }),
    ...(request.headers == null
      ? {}
      : {
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name, substitute(value)]),
          ),
        }),
    ...(request.body == null ? {} : { body: substitute(request.body) }),
  };
}

export function requestReferencesSecret(request: SubstitutableRequest): boolean {
  return (
    request.url.includes(SECRET_PLACEHOLDER) ||
    Object.values(request.headers ?? {}).some((value) => value.includes(SECRET_PLACEHOLDER)) ||
    (request.body?.includes(SECRET_PLACEHOLDER) ?? false)
  );
}
