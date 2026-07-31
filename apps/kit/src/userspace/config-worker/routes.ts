export type KitVoiceMode = "grok" | "tone";

export interface KitVoiceRouteDependencies {
  handlePcm(request: Request): Promise<Response>;
  readMode(): Promise<KitVoiceMode>;
}

/**
 * Keeps ordinary HTTP routing separate from Durable Object and provider
 * mechanics. This app intentionally does not own `/api`: devices connect
 * Cap'n Web directly to OS, while only the binary PCM lane enters userspace.
 */
export async function handleKitVoiceRequest(
  request: Request,
  dependencies: KitVoiceRouteDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({
      mode: await dependencies.readMode(),
      ok: true,
      service: "iterate-kit-voice",
    });
  }
  if (url.pathname === "/pcm") return await dependencies.handlePcm(request);
  return new Response("Not found.", { status: 404 });
}

interface ProjectCredential {
  projectId: string;
  projectToken: string;
}

interface ProjectCredentialSource {
  /*
   * Generated Cap'n Web target interfaces describe the settled member type,
   * while a live stub returns an awaitable expression for a property read.
   * Accept both shapes so production cannot accidentally compare the wrapper
   * object itself with an HTTP header.
   */
  projectId: string | PromiseLike<string>;
  secrets: {
    get(path: string): {
      reveal(): Promise<unknown>;
    };
  };
}

export async function loadProjectBearerCredential(
  project: ProjectCredentialSource,
): Promise<ProjectCredential> {
  const [projectId, projectToken] = await Promise.all([
    project.projectId,
    project.secrets.get("/secrets/project-api-key").reveal(),
  ]);
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("The scoped project did not expose a project id.");
  }
  if (typeof projectToken !== "string" || projectToken.length === 0) {
    throw new Error("/secrets/project-api-key did not contain a string.");
  }
  return { projectId, projectToken };
}

/**
 * The MVP deliberately uses the project's readable ingress key. Both the
 * stable project id and bearer must match the worker's scoped project so one
 * project's app host cannot be used as a confused deputy for another. This is
 * the seam to replace with independently revocable device OAuth credentials.
 */
export async function authenticateProjectBearer(
  request: Request,
  loadCredential: () => Promise<ProjectCredential>,
): Promise<{ projectId: string } | null> {
  const claimedProjectId = request.headers.get("x-iterate-project-id");
  const authorization = request.headers.get("authorization");
  if (!claimedProjectId || !authorization?.startsWith("Bearer ")) return null;

  const credential = await loadCredential();
  if (
    claimedProjectId !== credential.projectId ||
    !sameAsciiSecret(authorization.slice("Bearer ".length), credential.projectToken)
  ) {
    return null;
  }
  return { projectId: credential.projectId };
}

function sameAsciiSecret(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
