import JSON5 from "json5";

type ProjectEgressSecretResolver = {
  getSecretOrNull(input: { key: string }): Promise<{ material: string } | null>;
  getSecretSummaryByKeyOrNull(input: { key: string }): Promise<unknown | null>;
};

type SecretReference = {
  key: string;
  source: string;
};

const SECRET_REFERENCE_PATTERN = /getSecret\(([^()]*)\)/g;
const SECRET_REFERENCE_NAME = "getSecret(";

export class ProjectEgressSecretSubstitutionError extends Error {
  readonly header?: string;
  readonly secretKey?: string;

  constructor(input: { header?: string; message: string; secretKey?: string; cause?: unknown }) {
    super(input.message);
    this.name = "ProjectEgressSecretSubstitutionError";
    this.header = input.header;
    this.secretKey = input.secretKey;
    this.cause = input.cause;
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
  headers: Headers;
  projectEgressInterceptActive: boolean;
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
        header,
        projectEgressInterceptActive: input.projectEgressInterceptActive,
        reference,
        secrets: input.secrets,
      });
      nextValue = nextValue.replace(reference.source, () => replacement);
    }

    headers.set(header, nextValue);
    substituted = true;
  }

  return { headers, substituted };
}

export function parseSecretReferences(input: { header: string; value: string }): SecretReference[] {
  const references: SecretReference[] = [];
  let unmatchedValue = input.value;
  for (const match of input.value.matchAll(SECRET_REFERENCE_PATTERN)) {
    const source = match[0];
    try {
      const args = JSON5.parse(`[${match[1]}]`);
      let key = args[0];
      if (typeof key !== "string") key = args[0]?.key;
      if (!key || typeof key !== "string") throw new Error(`Use format getSecret('mykey')`);
      references.push({ key, source });
      unmatchedValue = unmatchedValue.replace(source, "");
    } catch (error) {
      throw new ProjectEgressSecretSubstitutionError({
        header: input.header,
        message: `Project egress secret substitution failed: Could not parse Secret reference ${source} in header "${input.header}".`,
        cause: error,
      });
    }
  }

  if (unmatchedValue.includes(SECRET_REFERENCE_NAME)) {
    throw new ProjectEgressSecretSubstitutionError({
      header: input.header,
      message: `Project egress secret substitution failed: Could not parse Secret reference ${SECRET_REFERENCE_NAME} in header "${input.header}".`,
    });
  }

  return references;
}

async function resolveSecretReference(input: {
  header: string;
  projectEgressInterceptActive: boolean;
  reference: SecretReference;
  secrets: ProjectEgressSecretResolver;
}) {
  if (input.projectEgressInterceptActive) {
    const secret = await input.secrets.getSecretSummaryByKeyOrNull({ key: input.reference.key });
    if (secret) {
      return `Secret value withheld because this Project Egress Intercept Tunnel is active. Requested ${JSON.stringify(input.reference.source)}`;
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
