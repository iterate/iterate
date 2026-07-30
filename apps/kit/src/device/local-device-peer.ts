import { RpcTarget, type RpcStub } from "@iterate-com/capnweb";
import type { M5StickS3 } from "./m5sticks3-contract.ts";

export type DeviceDisconnectReason = "peer-disposed" | "replaced" | "revoked";

export interface MountedM5StickS3 {
  readonly device: RpcStub<M5StickS3>;
  readonly disconnected: Promise<DeviceDisconnectReason>;
  readonly path: readonly string[];
}

export interface LocalDevicePeerOptions {
  mountPath: readonly string[];
  projectId: string;
  projectSecret: string;
}

export interface LocalDevicePeerRoot {
  authenticate(input: unknown): Promise<LocalDevicePeerSession>;
}

export interface LocalDevicePeerSession {
  readonly projects: LocalDeviceProjectCollection;
}

export interface LocalDeviceProjectCollection {
  get(projectReference: string): Promise<LocalDeviceProject>;
}

export interface LocalDeviceProject {
  provideCapability(input: unknown): Promise<LocalDeviceProvision>;
}

export interface LocalDeviceProvision {
  __describe(): Promise<{
    active: boolean;
    path: string[];
    providedAtOffset: number;
  }>;
  readonly path: string[];
  readonly providedAtOffset: number;
  revoke(): Promise<void>;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

class ActiveMount implements MountedM5StickS3 {
  readonly #disconnected = Promise.withResolvers<DeviceDisconnectReason>();
  readonly #onClose: (mount: ActiveMount) => void;
  #active = true;
  readonly device: RpcStub<M5StickS3>;
  readonly disconnected = this.#disconnected.promise;
  readonly path: readonly string[];

  constructor(
    device: RpcStub<M5StickS3>,
    path: readonly string[],
    onClose: (mount: ActiveMount) => void,
  ) {
    this.device = device;
    this.path = path;
    this.#onClose = onClose;
  }

  get active() {
    return this.#active;
  }

  close(reason: DeviceDisconnectReason) {
    if (!this.#active) return;
    this.#active = false;
    this.#onClose(this);
    this.device[Symbol.dispose]();
    this.#disconnected.resolve(reason);
  }
}

class ProvisionTarget extends RpcTarget {
  readonly #mount: ActiveMount;

  constructor(mount: ActiveMount) {
    super();
    this.#mount = mount;
  }

  async __describe() {
    return {
      active: this.#mount.active,
      path: [...this.#mount.path],
      providedAtOffset: 1,
    };
  }

  get path() {
    return [...this.#mount.path];
  }

  get providedAtOffset() {
    return 1;
  }

  async revoke() {
    this.#mount.close("revoked");
  }

  [Symbol.dispose]() {
    this.#mount.close("revoked");
  }
}

class ProjectTarget extends RpcTarget {
  readonly #peer: LocalDevicePeer;

  constructor(peer: LocalDevicePeer) {
    super();
    this.#peer = peer;
  }

  async provideCapability(input: unknown) {
    return new ProvisionTarget(this.#peer.mount(input));
  }
}

class ProjectCollectionTarget extends RpcTarget {
  readonly #peer: LocalDevicePeer;

  constructor(peer: LocalDevicePeer) {
    super();
    this.#peer = peer;
  }

  async get(projectReference: string) {
    this.#peer.assertProjectReference(projectReference);
    return new ProjectTarget(this.#peer);
  }
}

class SessionTarget extends RpcTarget {
  readonly #peer: LocalDevicePeer;

  constructor(peer: LocalDevicePeer) {
    super();
    this.#peer = peer;
  }

  get projects() {
    return new ProjectCollectionTarget(this.#peer);
  }
}

class RootTarget extends RpcTarget {
  readonly #peer: LocalDevicePeer;

  constructor(peer: LocalDevicePeer) {
    super();
    this.#peer = peer;
  }

  async authenticate(input: unknown) {
    this.#peer.assertCredentials(input);
    return new SessionTarget(this.#peer);
  }
}

export class LocalDevicePeer implements Disposable {
  readonly #mountPath: readonly string[];
  readonly #projectId: string;
  readonly #projectSecret: string;
  #activeMount?: ActiveMount;
  #nextMount: Deferred<MountedM5StickS3> = Promise.withResolvers<MountedM5StickS3>();
  #disposed = false;

  constructor(options: LocalDevicePeerOptions) {
    if (options.mountPath.length === 0) {
      throw new TypeError("The local device mount path must not be empty.");
    }
    if (!options.mountPath.every((part) => part.length > 0)) {
      throw new TypeError("Every local device mount path part must be non-empty.");
    }
    if (!options.projectId.startsWith("prj_")) {
      throw new TypeError("The local device project ID must start with prj_.");
    }
    if (options.projectSecret.length === 0) {
      throw new TypeError("The local device project secret must not be empty.");
    }
    this.#mountPath = [...options.mountPath];
    this.#projectId = options.projectId;
    this.#projectSecret = options.projectSecret;
  }

  get activeMount(): MountedM5StickS3 | undefined {
    return this.#activeMount;
  }

  get pcmSessionId() {
    return `${this.#projectId}:${this.#mountPath.join("/")}`;
  }

  createRpcRoot(): LocalDevicePeerRoot & RpcTarget {
    this.#assertNotDisposed();
    return new RootTarget(this);
  }

  waitForMount(): Promise<MountedM5StickS3> {
    this.#assertNotDisposed();
    return this.#activeMount ? Promise.resolve(this.#activeMount) : this.#nextMount.promise;
  }

  assertCredentials(input: unknown) {
    const credentials = requireRecord(input, "project credentials");
    if (
      credentials.type !== "project-secret" ||
      credentials.projectId !== this.#projectId ||
      credentials.secret !== this.#projectSecret
    ) {
      throw new Error("The device supplied invalid project credentials.");
    }
  }

  assertProjectReference(projectReference: string) {
    if (projectReference !== this.#projectId) {
      throw new Error(`The device requested unexpected project reference ${projectReference}.`);
    }
  }

  acceptsProjectBearerCredentials(projectReference: string, bearerToken: string) {
    return projectReference === this.#projectId && bearerToken === this.#projectSecret;
  }

  mount(input: unknown): ActiveMount {
    this.#assertNotDisposed();
    const recipe = requireRecord(input, "live capability recipe");
    if (recipe.type !== "live") {
      throw new TypeError("The device capability recipe type must be live.");
    }
    if (!sameStringArray(recipe.path, this.#mountPath)) {
      throw new Error("The device supplied an unexpected capability mount path.");
    }
    if (recipe.instructions !== undefined && typeof recipe.instructions !== "string") {
      throw new TypeError("Capability instructions must be a string.");
    }
    if (recipe.types !== undefined && typeof recipe.types !== "string") {
      throw new TypeError("Capability types must be a string.");
    }

    const capability = recipe.capability;
    if (
      !(capability instanceof RpcTarget) ||
      typeof (capability as { dup?: unknown }).dup !== "function"
    ) {
      throw new TypeError("The live capability must be a retained Cap'n Web device stub.");
    }

    /*
     * Runtime checks above establish Cap'n Web's branded RpcTarget and dup()
     * surface. The wire protocol cannot carry M5StickS3's generic TypeScript
     * parameter, so this is the boundary where we apply that application type.
     */
    const retainedDevice = (capability as unknown as RpcStub<M5StickS3>).dup();
    this.#activeMount?.close("replaced");
    const mount = new ActiveMount(retainedDevice, this.#mountPath, (closedMount) => {
      if (this.#activeMount === closedMount) {
        this.#activeMount = undefined;
        this.#nextMount = Promise.withResolvers<MountedM5StickS3>();
      }
    });
    this.#activeMount = mount;
    this.#nextMount.resolve(mount);
    return mount;
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeMount?.close("peer-disposed");
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw new Error("The local device peer has been disposed.");
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((part, index) => typeof part === "string" && part === expected[index])
  );
}
