type ProjectEgressSecretResolver = {
  getSecretOrNull(input: { key: string }): Promise<{ material: string } | null>;
  getSecretSummaryByKeyOrNull(input: { key: string }): Promise<unknown | null>;
};

type SecretReference = {
  key: string;
  source: string;
};

const SECRET_REFERENCE_PATTERN = /getSecret\(\s*\{\s*key\s*:\s*(["'])([^"'\\]+)\1\s*\}\s*\)/g;
const SECRET_REFERENCE_NAME = "getSecret(";

export class ProjectEgressSecretSubstitutionError extends Error {
  readonly header?: string;
  readonly secretKey?: string;

  constructor(input: { header?: string; message: string; secretKey?: string }) {
    super(input.message);
    this.name = "ProjectEgressSecretSubstitutionError";
    this.header = input.header;
    this.secretKey = input.secretKey;
  }

  toResponse() {
    return Response.json(
      {
        error: "project_egress_secret_substitution_failed",
        message: this.message,
        ...(this.header == null ? {} : { header: this.header }),
        ...(this.secretKey == null ? {} : { secretKey: this.secretKey }),
      },
      { status: 502 },
    );
  }
}

export async function substituteProjectEgressSecretHeaders(input: {
  externalEgressProxyUrl: string | null;
  headers: Headers;
  secrets: ProjectEgressSecretResolver;
}) {
  let substituted = false;
  const headers = new Headers(input.headers);

  for (const [header, value] of input.headers) {
    const references = parseSecretReferences({ header, value });
    if (references.length === 0) continue;

    let nextValue = value;
    for (const reference of references) {
      const replacement = await resolveSecretReference({
        externalEgressProxyUrl: input.externalEgressProxyUrl,
        header,
        reference,
        secrets: input.secrets,
      });
      nextValue = nextValue.replace(reference.source, replacement);
    }

    headers.set(header, nextValue);
    substituted = true;
  }

  return { headers, substituted };
}

export function parseSecretReferences(input: { header: string; value: string }): SecretReference[] {
  if (!input.value.includes(SECRET_REFERENCE_NAME)) return [];

  const references: SecretReference[] = [];
  let unmatchedValue = input.value;
  for (const match of input.value.matchAll(SECRET_REFERENCE_PATTERN)) {
    const source = match[0];
    const key = match[2];
    if (!key) continue;

    references.push({ key, source });
    unmatchedValue = unmatchedValue.replace(source, "");
  }

  if (references.length === 0 || unmatchedValue.includes(SECRET_REFERENCE_NAME)) {
    throw new ProjectEgressSecretSubstitutionError({
      header: input.header,
      message: `Project egress secret substitution failed: Could not parse Secret reference in header "${input.header}".`,
    });
  }

  return references;
}

async function resolveSecretReference(input: {
  externalEgressProxyUrl: string | null;
  header: string;
  reference: SecretReference;
  secrets: ProjectEgressSecretResolver;
}) {
  if (input.externalEgressProxyUrl) {
    const secret = await input.secrets.getSecretSummaryByKeyOrNull({ key: input.reference.key });
    if (secret) {
      return `Secret value withheld because this project uses externalEgressProxyUrl. Requested ${input.reference.source}`;
    }

    return secretNotFound(input);
  }

  const secret = await input.secrets.getSecretOrNull({ key: input.reference.key });
  if (secret) return secret.material;

  return secretNotFound(input);
}

function secretNotFound(input: { header: string; reference: SecretReference }): never {
  throw new ProjectEgressSecretSubstitutionError({
    header: input.header,
    message: `Project egress secret substitution failed: Secret not found for key "${input.reference.key}".`,
    secretKey: input.reference.key,
  });
}
