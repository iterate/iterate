import { signJWT, verifyJWT } from "better-auth/crypto";
import type {
  MintProjectAppSessionInput,
  ValidatedProjectAppSession,
  ValidateProjectAppSessionInput,
} from "@iterate-com/auth-contract/worker";
import { z } from "zod";

const SESSION_TTL_SECONDS = 15 * 60;

const ProjectAppSessionClaims = z
  .object({
    audience: z.string(),
    // Display identity for the app behind the proxy (presence, authorship).
    // Optional: pre-rollout tokens without them stay valid, and they carry
    // no authority — userId is the principal; these are what to call it.
    email: z.string().trim().min(1).max(320).optional(),
    exp: z.number().int(),
    iat: z.number().int(),
    image: z.string().trim().min(1).max(2048).optional(),
    // The sign-in this token descends from; renewals carry it forward.
    // Optional: pre-rollout tokens read as signed in at issue.
    loginAt: z.number().int().optional(),
    name: z.string().trim().min(1).max(256).optional(),
    projectId: z.string().trim().min(1).max(256),
    type: z.literal("project-app-session"),
    userId: z.string().trim().min(1).max(256),
  })
  .strict();

type SessionDependencies = {
  secret: string;
  userCanAccessProject(input: { projectId: string; userId: string }): Promise<boolean>;
};

/** Mint a short-lived app-origin token for a current project member or platform admin. */
export async function mintProjectAppSession(
  rawInput: MintProjectAppSessionInput,
  dependencies: SessionDependencies,
): Promise<{ expiresAt: number; token: string } | null> {
  const input = parseMintInput(rawInput);
  if (
    !(await dependencies.userCanAccessProject({
      projectId: input.projectId,
      userId: input.userId,
    }))
  ) {
    return null;
  }

  const token = await signJWT(
    {
      audience: input.audience,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.image === undefined ? {} : { image: input.image }),
      loginAt: input.loginAt ?? Math.floor(Date.now() / 1000),
      ...(input.name === undefined ? {} : { name: input.name }),
      projectId: input.projectId,
      type: "project-app-session",
      userId: input.userId,
    },
    dependencies.secret,
    SESSION_TTL_SECONDS,
  );
  // The signer stamps `exp` itself; report exactly that so the gate's cookie
  // Max-Age never drifts from the token it carries.
  return { expiresAt: expiryOf(token), token };
}

/** The `exp` claim of a token this module just signed (payload only, no verification). */
function expiryOf(token: string): number {
  const payload = token.split(".")[1] ?? "";
  const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
  return z.object({ exp: z.number().int() }).parse(JSON.parse(json)).exp;
}

/** Verify signature and scope, then re-check access so revocation and admin demotion are live. */
export async function validateProjectAppSession(
  rawInput: ValidateProjectAppSessionInput,
  dependencies: SessionDependencies,
): Promise<ValidatedProjectAppSession | null> {
  let input: ReturnType<typeof parseValidateInput>;
  let rawClaims: unknown;
  try {
    input = parseValidateInput(rawInput);
    rawClaims = await verifyJWT<unknown>(input.token, dependencies.secret);
  } catch {
    return null;
  }
  const parsed = ProjectAppSessionClaims.safeParse(rawClaims);
  if (!parsed.success) return null;

  const claims = parsed.data;
  if (claims.audience !== input.audience || claims.projectId !== input.projectId) return null;
  if (
    !(await dependencies.userCanAccessProject({
      projectId: claims.projectId,
      userId: claims.userId,
    }))
  ) {
    return null;
  }
  return {
    ...(claims.email === undefined ? {} : { email: claims.email }),
    expiresAt: claims.exp,
    ...(claims.image === undefined ? {} : { image: claims.image }),
    // A pre-rollout token has no loginAt: it was signed in when issued.
    loginAt: claims.loginAt ?? claims.iat,
    ...(claims.name === undefined ? {} : { name: claims.name }),
    userId: claims.userId,
  };
}

function parseMintInput(input: MintProjectAppSessionInput) {
  return {
    audience: parseAudience(input.audience),
    email: optionalDisplayField(input.email, 320),
    image: optionalDisplayField(input.image, 2048),
    loginAt: z.number().int().nonnegative().optional().parse(input.loginAt),
    name: optionalDisplayField(input.name, 256),
    projectId: z.string().trim().min(1).max(256).parse(input.projectId),
    userId: z.string().trim().min(1).max(256).parse(input.userId),
  };
}

/** Empty or absent display fields stay out of the claims entirely. */
function optionalDisplayField(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = z.string().max(maxLength).optional().parse(value)?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function parseValidateInput(input: ValidateProjectAppSessionInput) {
  return {
    audience: parseAudience(input.audience),
    projectId: z.string().trim().min(1).max(256).parse(input.projectId),
    token: z.string().trim().min(1).max(8192).parse(input.token),
  };
}

function parseAudience(value: string): string {
  const url = new URL(z.url().parse(value));
  if (url.username || url.password || (url.protocol !== "https:" && !isLocalHost(url.hostname))) {
    throw new Error("Project app sessions require an HTTPS origin");
  }
  return url.origin;
}

function isLocalHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}
