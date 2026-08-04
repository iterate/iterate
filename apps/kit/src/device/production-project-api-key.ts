import { connectItxReady } from "iterate/node";

interface ProjectApiKeyResolutionInput {
  adminApiSecret?: string;
  baseUrl: string;
  projectApiKey?: string;
  projectId: string;
}

interface ProjectApiKeyRevealInput {
  adminApiSecret: string;
  baseUrl: string;
  projectId: string;
}

type RevealProjectApiKey = (input: ProjectApiKeyRevealInput) => Promise<unknown>;

/**
 * Obtains the narrow project ingress credential used by a physical proof.
 *
 * Device configuration remains the preferred source. When it is unavailable,
 * a Doppler-backed test harness may use deployment authority for the pairing
 * ceremony only: reveal the project's deliberately readable born key in
 * memory, dispose the admin connection, and then let the caller establish its
 * measured session through project-secret auth. This is deliberately not a
 * device fallback and neither credential is written to logs or artifacts.
 */
export async function resolveProductionProjectApiKey(
  input: ProjectApiKeyResolutionInput,
  reveal: RevealProjectApiKey = revealProjectApiKeyWithAdmin,
) {
  const direct = input.projectApiKey?.trim();
  if (direct) return requireProjectApiKey(direct);

  const adminApiSecret = input.adminApiSecret?.trim();
  if (!adminApiSecret) {
    throw new Error("A project ingress credential or admin pairing credential is required.");
  }
  const revealed = await reveal({
    adminApiSecret,
    baseUrl: input.baseUrl,
    projectId: input.projectId,
  });
  return requireProjectApiKey(revealed);
}

async function revealProjectApiKeyWithAdmin(input: ProjectApiKeyRevealInput) {
  using admin = await connectItxReady({
    auth: { secret: input.adminApiSecret, type: "admin-secret" },
    baseUrl: input.baseUrl,
  });
  using project = await admin.projects.get(input.projectId);
  return project.secrets.get("/secrets/project-api-key").reveal();
}

function requireProjectApiKey(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("itxk_")) {
    throw new Error("The production project's readable ingress key was absent or malformed.");
  }
  return value;
}
