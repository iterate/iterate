import JSON5 from "json5";

type ProjectEgressSecretResolver = {
  getSecretOrNull(input: { key: string }): Promise<{ material: string } | null>;
  getSecretSummaryByKeyOrNull(input: { key: string }): Promise<unknown | null>;
};

type SecretReference = {
  key: string;
  source: string;
};

const SECRET_REFERENCE_NAME = "getSecret(";

type SecretReferenceParseResult = [errorResponse: Response | null, references: SecretReference[]];

type SecretReferenceResolutionResult = [errorResponse: Response | null, value: string];

export type SubstituteProjectEgressSecretHeadersResult = [
  errorResponse: Response | null,
  substitutedHeaders: Record<string, string>,
];

export async function substituteProjectEgressSecretHeaders(input: {
  headers: Headers;
  secrets: ProjectEgressSecretResolver;
}): Promise<SubstituteProjectEgressSecretHeadersResult> {
  const substitutedHeaders: Record<string, string> = {};

  for (const [header, value] of input.headers) {
    const [parseError, references] = parseSecretReferences({ header, value });
    if (parseError) return [parseError, substitutedHeaders];
    if (references.length === 0) continue;

    let nextValue = value;
    for (const reference of references) {
      const [resolveError, replacement] = await resolveSecretReference({
        header,
        reference,
        secrets: input.secrets,
      });
      if (resolveError) return [resolveError, substitutedHeaders];
      nextValue = nextValue.replace(reference.source, () => replacement);
      substitutedHeaders[header] = nextValue;
    }
  }

  return [null, substitutedHeaders];
}

export function parseSecretReferences(input: {
  header: string;
  value: string;
}): SecretReferenceParseResult {
  const references: SecretReference[] = [];
  let searchStart = 0;

  while (searchStart < input.value.length) {
    const start = input.value.indexOf(SECRET_REFERENCE_NAME, searchStart);
    if (start === -1) break;

    const argumentStart = start + SECRET_REFERENCE_NAME.length;
    const end = findSecretReferenceEnd(input.value, argumentStart);
    const source = end === -1 ? input.value.slice(start) : input.value.slice(start, end + 1);
    if (end === -1) {
      return [parseSecretReferenceError({ header: input.header, source }), []];
    }

    let args: any[];
    try {
      args = JSON5.parse(`[${input.value.slice(argumentStart, end)}]`) as any[];
    } catch {
      return [parseSecretReferenceError({ header: input.header, source }), []];
    }

    let key = args[0];
    if (typeof key !== "string") key = args[0]?.key;
    if (!key || typeof key !== "string") {
      return [parseSecretReferenceError({ header: input.header, source }), []];
    }
    references.push({ key, source });

    searchStart = end + 1;
  }

  return [null, references];
}

async function resolveSecretReference(input: {
  header: string;
  reference: SecretReference;
  secrets: ProjectEgressSecretResolver;
}): Promise<SecretReferenceResolutionResult> {
  const secret = await input.secrets.getSecretOrNull({ key: input.reference.key });
  if (secret) return [null, secret.material];

  return secretNotFound(input);
}

function findSecretReferenceEnd(value: string, argumentStart: number) {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;

  for (let index = argumentStart; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function parseSecretReferenceError(input: { header: string; source: string }) {
  return clientErrorResponse({
    header: input.header,
    message: `Project egress secret substitution failed: Could not parse Secret reference ${input.source} in header "${input.header}".`,
  });
}

function secretNotFound(input: {
  header: string;
  reference: SecretReference;
}): SecretReferenceResolutionResult {
  return [
    clientErrorResponse({
      header: input.header,
      message: `Project egress secret substitution failed: Secret not found for key "${input.reference.key}".`,
      secretKey: input.reference.key,
    }),
    "",
  ];
}

function clientErrorResponse(input: { header: string; message: string; secretKey?: string }) {
  return Response.json(
    {
      error: "project_egress_secret_substitution_failed",
      header: input.header,
      message: input.message,
      ...(input.secretKey == null ? {} : { secretKey: input.secretKey }),
    },
    { status: 400 },
  );
}
