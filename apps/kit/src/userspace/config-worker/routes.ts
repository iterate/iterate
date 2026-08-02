import { isKitDeviceId } from "./device-id.ts";

export type KitVoiceMode = "grok" | "tone";
export type KitAudioMode = "full-duplex-aec" | "push-to-talk";
export const KIT_DEVICE_ID_HEADER = "x-iterate-kit-device-id";
export const KIT_AUDIO_MODE_HEADER = "x-iterate-kit-audio-mode";

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

/**
 * Reads the firmware-owned identity used beneath both `kit` and `devices`.
 *
 * Authentication remains project-scoped; this value selects only a child of
 * those two fixed namespaces. Requiring the same conservative slug grammar on
 * both sides prevents path ambiguity and, more importantly, prevents missing
 * identity from silently recording one board's physical evidence as another.
 */
export function readKitDeviceIdentity(request: Request): string | null {
  const deviceId = request.headers.get(KIT_DEVICE_ID_HEADER);
  if (deviceId === null || !isKitDeviceId(deviceId)) {
    return null;
  }
  return deviceId;
}

/**
 * Reads the immutable turn policy negotiated by firmware for this PCM socket.
 *
 * Device ids identify capability children; they must never double as an audio
 * policy switch. Keeping this a closed wire union makes unknown/new firmware
 * fail the handshake visibly instead of letting one side treat a zero-length
 * frame as a PTT commit while the other expects provider-owned server VAD.
 */
export function readKitAudioMode(request: Request): KitAudioMode | null {
  const mode = request.headers.get(KIT_AUDIO_MODE_HEADER);
  return mode === "push-to-talk" || mode === "full-duplex-aec" ? mode : null;
}

function sameAsciiSecret(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
