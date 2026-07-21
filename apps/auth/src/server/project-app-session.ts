import { signJWT, verifyJWT } from "better-auth/crypto";
import type {
  MintProjectAppSessionInput,
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
): Promise<{ token: string } | null> {
  const input = parseMintInput(rawInput);
  if (
    !(await dependencies.userCanAccessProject({
      projectId: input.projectId,
      userId: input.userId,
    }))
  ) {
    return null;
  }

  return {
    token: await signJWT(
      {
        audience: input.audience,
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.name === undefined ? {} : { name: input.name }),
        projectId: input.projectId,
        type: "project-app-session",
        userId: input.userId,
      },
      dependencies.secret,
      SESSION_TTL_SECONDS,
    ),
  };
}

/** Verify signature and scope, then re-check access so revocation and admin demotion are live. */
export async function validateProjectAppSession(
  rawInput: ValidateProjectAppSessionInput,
  dependencies: SessionDependencies,
): Promise<{ expiresAt: number; userId: string } | null> {
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
  return { expiresAt: claims.exp, userId: claims.userId };
}

function parseMintInput(input: MintProjectAppSessionInput) {
  return {
    audience: parseAudience(input.audience),
    email: optionalDisplayField(input.email, 320),
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
