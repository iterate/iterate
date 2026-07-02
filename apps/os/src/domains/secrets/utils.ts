import { normalizePath } from "../durable-object-names.ts";

const SECRET_REFERENCE = /getSecret\(\s*\{\s*path\s*:\s*"([^"]+)"\s*\}\s*\)/g;

type SecretErrorCode =
  | "multiple_secret_paths_not_supported"
  | "secret_not_allowed_for_origin"
  | "secret_not_found"
  | "secret_reference_required";

export function normalizeSecretPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/secrets/")) {
    throw new Error(`secret path must start with "/secrets/", got "${normalized}"`);
  }
  return normalized;
}

export function secretReferencePathsFromHeaders(headers: Headers): string[] {
  const paths = new Set<string>();
  headers.forEach((value) => {
    for (const match of value.matchAll(SECRET_REFERENCE)) {
      paths.add(normalizeSecretPath(match[1]!));
    }
  });
  return [...paths];
}

export function requestWithSecretHeaders(input: {
  material: string;
  path: string;
  request: Request;
}): Request {
  const headers = new Headers(input.request.headers);
  headers.forEach((value, name) => {
    headers.set(
      name,
      value.replaceAll(SECRET_REFERENCE, (_match, path: string) =>
        normalizeSecretPath(path) === input.path ? input.material : _match,
      ),
    );
  });
  return new Request(input.request, { headers });
}

export function secretErrorResponse(code: SecretErrorCode, status: number): Response {
  return Response.json({ error: code }, { status });
}
