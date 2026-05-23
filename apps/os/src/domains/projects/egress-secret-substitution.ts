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

export type ProjectEgressSecretSubstitutionClientError = {
  header: string;
  message: string;
  secretKey?: string;
};

type SecretReferenceParseResult =
  | { ok: true; references: SecretReference[] }
  | { ok: false; error: ProjectEgressSecretSubstitutionClientError };

type SecretReferenceResolutionResult =
  | { ok: true; value: string }
  | { ok: false; error: ProjectEgressSecretSubstitutionClientError };

export type SubstituteProjectEgressSecretHeadersResult =
  | { ok: true; headers: Headers; substituted: boolean }
  | { ok: false; error: ProjectEgressSecretSubstitutionClientError };

export function projectEgressSecretSubstitutionClientErrorToResponse(
  error: ProjectEgressSecretSubstitutionClientError,
) {
  return Response.json(
    {
      error: "project_egress_secret_substitution_failed",
      message: error.message,
      header: error.header,
      ...(error.secretKey == null ? {} : { secretKey: error.secretKey }),
    },
    { status: 400 },
  );
}

export async function substituteProjectEgressSecretHeaders(input: {
  headers: Headers;
  projectEgressInterceptActive: boolean;
  secrets: ProjectEgressSecretResolver;
}): Promise<SubstituteProjectEgressSecretHeadersResult> {
  let substituted = false;
  const headers = new Headers(input.headers);

  for (const [header, value] of input.headers) {
    const parsed = parseSecretReferences({ header, value });
    if (!parsed.ok) return parsed;
    const references = parsed.references;
    if (references.length === 0) continue;

    let nextValue = value;
    for (const reference of references) {
      const replacement = await resolveSecretReference({
        header,
        projectEgressInterceptActive: input.projectEgressInterceptActive,
        reference,
        secrets: input.secrets,
      });
      if (!replacement.ok) return replacement;
      nextValue = nextValue.replace(reference.source, () => replacement.value);
    }

    headers.set(header, nextValue);
    substituted = true;
  }

  return { ok: true, headers, substituted };
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
      return parseSecretReferenceError({ header: input.header, source });
    }

    let args: any[];
    try {
      args = JSON5.parse(`[${input.value.slice(argumentStart, end)}]`) as any[];
    } catch {
      return parseSecretReferenceError({ header: input.header, source });
    }

    let key = args[0];
    if (typeof key !== "string") key = args[0]?.key;
    if (!key || typeof key !== "string") {
      return parseSecretReferenceError({ header: input.header, source });
    }
    references.push({ key, source });

    searchStart = end + 1;
  }

  return { ok: true, references };
}

async function resolveSecretReference(input: {
  header: string;
  projectEgressInterceptActive: boolean;
  reference: SecretReference;
  secrets: ProjectEgressSecretResolver;
}): Promise<SecretReferenceResolutionResult> {
  if (input.projectEgressInterceptActive) {
    const secret = await input.secrets.getSecretSummaryByKeyOrNull({ key: input.reference.key });
    if (secret) {
      return {
        ok: true,
        value: `Secret value withheld because this Project Egress Intercept Tunnel is active. Requested ${JSON.stringify(input.reference.source)}`,
      };
    }

    return secretNotFound(input);
  }

  const secret = await input.secrets.getSecretOrNull({ key: input.reference.key });
  if (secret) return { ok: true, value: secret.material };

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

function parseSecretReferenceError(input: {
  header: string;
  source: string;
}): SecretReferenceParseResult {
  return {
    ok: false,
    error: {
      header: input.header,
      message: `Project egress secret substitution failed: Could not parse Secret reference ${input.source} in header "${input.header}".`,
    },
  };
}

function secretNotFound(input: {
  header: string;
  reference: SecretReference;
}): SecretReferenceResolutionResult {
  return {
    ok: false,
    error: {
      header: input.header,
      message: `Project egress secret substitution failed: Secret not found for key "${input.reference.key}".`,
      secretKey: input.reference.key,
    },
  };
}
