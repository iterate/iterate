import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import type { ItxAuthCredentials, Project, UnauthenticatedOs } from "iterate/client";

export type ProjectCredential = Extract<
  ItxAuthCredentials,
  { type: "project-app-session" | "project-secret" }
>;

/**
 * A lazy, reconnecting dial from an external app vessel to one authenticated
 * Iterate project.
 */
export class ProjectDial {
  #project: RpcStub<Project> | null = null;
  #socket: WebSocket | null = null;
  #session: { [Symbol.dispose]?: () => void } | null = null;
  #closed = false;

  constructor(
    private readonly osBaseUrl: string,
    private readonly projectAddress: string,
    private readonly credential: ProjectCredential,
  ) {}

  async #open(): Promise<RpcStub<Project>> {
    this.#dispose();
    const response = await fetch(new URL("/api", this.osBaseUrl).toString(), {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`os /api did not upgrade: ${response.status}`);
    socket.accept();
    // Workers' WebSocketPair socket and the DOM WebSocket exposed by capnweb
    // are runtime-compatible; their ambient type declarations are not.
    this.#socket = socket as unknown as WebSocket;
    const os = newWebSocketRpcSession<UnauthenticatedOs>(socket as unknown as WebSocket);
    // Cap'n Web stubs implement explicit resource management at runtime, but
    // that transport lifecycle member is absent from the generated RPC type.
    this.#session = os as unknown as { [Symbol.dispose]?: () => void };
    const session = os.authenticate(this.credential);
    // Cap'n Web's promise-aware proxy maps this generated method through a
    // wider conditional type; at runtime this is the requested Project stub.
    return session.projects.get(this.projectAddress) as unknown as RpcStub<Project>;
  }

  async withProject<T>(operation: (project: RpcStub<Project>) => PromiseLike<T>): Promise<T> {
    if (this.#closed) throw new Error("connection closed");
    this.#project ??= await this.#open();
    try {
      return await operation(this.#project);
    } catch (firstError) {
      this.#project = await this.#open();
      try {
        return await operation(this.#project);
      } catch (secondError) {
        this.#project = null;
        throw secondError ?? firstError;
      }
    }
  }

  #dispose(): void {
    try {
      this.#session?.[Symbol.dispose]?.();
    } catch {
      // Disposing a half-open transport can race its own close.
    }
    try {
      this.#socket?.close();
    } catch {
      // Closing an already-closed transport is harmless.
    }
    this.#socket = null;
    this.#session = null;
    this.#project = null;
  }

  close(): void {
    this.#closed = true;
    this.#dispose();
  }
}

/** The id-or-slug accepted by the platform's project collection. */
export function projectCredentialAddress(credential: ProjectCredential): string {
  if (credential.type === "project-app-session") {
    return projectIdClaim(credential.token);
  }
  if (typeof credential.projectId === "string" && credential.projectId !== "") {
    return credential.projectId;
  }
  if (typeof credential.projectSlug === "string" && credential.projectSlug !== "") {
    return credential.projectSlug;
  }
  throw new Error("project-secret credential has no project id or slug");
}

/**
 * Read the unverified project claim only to select the project capability.
 * The subsequent platform call verifies the same credential against it.
 */
export function projectIdClaim(token: string): string {
  const claims = tokenClaims(token);
  if (typeof claims.projectId === "string" && claims.projectId !== "") {
    return claims.projectId;
  }
  throw new Error("session token is not a project-app-session JWT");
}

export function tokenClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return {};
  const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    const claims: unknown = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4)));
    if (typeof claims !== "object" || !claims || Array.isArray(claims)) return {};
    // The checks above prove this is a non-null object. Its members remain
    // unknown until each caller validates the claim it consumes.
    return claims as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
