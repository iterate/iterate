import { DurableObject } from "cloudflare:workers";
import { type ProcessorState, type StreamEventInput } from "iterate/processors";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { isUnconfiguredSubscriptionError } from "../streams/utils.ts";
import { deviceCreationEvents } from "./device-defaults.ts";
import { DeviceProcessorContract } from "./device-processor-contract.ts";
import { appendAfterPushTokenSecretUpdate } from "./push-token-consistency.ts";
import type { DeviceAppendInput, DeviceDescription, DeviceEnrollInput } from "./types.ts";
import { PUBLIC_DEVICE_EVENT_TYPES } from "./types.ts";

const INGEST_WAIT_TIMEOUT_MS = 15_000;
const EXPO_PUSH_ORIGIN = "https://exp.host";

/** The stream facade methods this DO reads its own fold through — the device
 * processor runs as a facet of the device stream's own Durable Object
 * (src/domains/processor-facet-durable-object.ts), not here. */
type DeviceProcessorFacade = {
  snapshot(): Promise<{ offset: number; state: ProcessorState<DeviceProcessorContract> }>;
  waitUntilProcessed(input: { offset: number; timeoutMs?: number }): Promise<void>;
};

/**
 * The device's DOMAIN Durable Object: authenticated enrollment/revocation and
 * the push-token Secret lifecycle, serialized on one credential-update chain.
 * The device stream processor itself is hosted as a facet of the device's
 * Stream Durable Object; this DO reads the committed fold back through the
 * stream's processor facade.
 */
export class DeviceDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #deviceId = deviceIdFromPath(this.#name.path);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  #credentialUpdates: Promise<void> = Promise.resolve();

  async #processorFacade(): Promise<DeviceProcessorFacade> {
    // Safe: the Stream DO's processorFacade(name) forwards to the facet
    // subclass registered for this path family, and the facet composition
    // registers the DeviceProcessor under DeviceProcessorContract.slug on
    // /devices/* paths — so snapshot() serves the device contract's fold.
    // The RPC-generated facade type is untyped per name (the name is a
    // runtime string), hence the assertion instead of a typed boundary.
    return (await this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        path: this.#name.path,
        projectId: this.#name.projectId,
      }),
    ).processorFacade({
      name: DeviceProcessorContract.slug,
    })) as unknown as DeviceProcessorFacade;
  }

  kill(): void {
    this.ctx.abort("kill requested");
  }

  enroll(input: DeviceEnrollInput & { ownerId: string }) {
    return this.#serializeCredentialUpdate(() => this.#enroll(input));
  }

  async #enroll(input: DeviceEnrollInput & { ownerId: string }) {
    assertEnrollInput(input);
    const snapshot = await this.#snapshot();
    const existingOwner = snapshot.state.birthCertificate?.config.ownerId;
    const pushTokenSecretUpdatedOffset = await this.#putPushTokenSecret(input.expoPushToken);
    if (!existingOwner) {
      const committed = await this.#appendAfterPushTokenSecretUpdate(
        pushTokenSecretUpdatedOffset,
        ...deviceCreationEvents({
          deviceId: this.#deviceId,
          projectId: this.#name.projectId,
          payload: {
            config: {
              appVersion: input.appVersion,
              label: input.label,
              notificationsStatus: input.notificationsStatus,
              ownerId: input.ownerId,
              platform: input.platform,
              pushTokenSecretPath: this.#pushTokenSecretPath,
              pushTokenSecretUpdatedOffset,
            },
          },
        }),
      );
      const offset = committed.reduce((maximum, event) => Math.max(maximum, event.offset), 0);
      if (offset === 0) throw new Error("device enrollment committed no birth events");
      await this.#waitUntilProcessed(offset);
      return describeDeviceState((await this.#snapshot()).state, this.#deviceId);
    }
    const [updated] = await this.#appendAfterPushTokenSecretUpdate(pushTokenSecretUpdatedOffset, {
      type: "events.iterate.com/device/push-token-updated",
      idempotencyKey: `device/push-token-updated:${pushTokenSecretUpdatedOffset}`,
      payload: {
        appVersion: input.appVersion,
        label: input.label,
        notificationsStatus: input.notificationsStatus,
        ownerId: input.ownerId,
        pushTokenSecretPath: this.#pushTokenSecretPath,
        pushTokenSecretUpdatedOffset,
      },
    } as StreamEventInput);
    await this.#waitUntilProcessed(updated!.offset);
    return describeDeviceState((await this.#snapshot()).state, this.#deviceId);
  }

  async #appendAfterPushTokenSecretUpdate(
    pushTokenSecretUpdatedOffset: number,
    ...events: StreamEventInput[]
  ) {
    return await appendAfterPushTokenSecretUpdate({
      append: () => this.#stream.append(...events),
      clearUpdatedSecret: () =>
        this.#clearPushTokenSecret({
          pushTokenSecretPath: this.#pushTokenSecretPath,
          pushTokenSecretUpdatedOffset,
        }),
    });
  }

  async append(...events: DeviceAppendInput[]) {
    const snapshot = await this.#snapshot();
    if (!snapshot.state.birthCertificate) throw new Error("device has not been enrolled");
    const parsed = events.map((event) => {
      const consumed = DeviceProcessorContract.parseConsumedInput(event);
      if (!PUBLIC_DEVICE_EVENT_TYPES.has(consumed.type as never)) {
        throw new Error(`device append does not accept lifecycle event ${consumed.type}`);
      }
      return consumed as DeviceAppendInput;
    });
    const committed = await this.#stream.append(...(parsed as StreamEventInput[]));
    if (committed.length) {
      await this.#waitUntilProcessed(Math.max(...committed.map((event) => event.offset)));
    }
    return committed;
  }

  revoke(reason: "disabled" | "permission-denied" | "sign-out") {
    return this.#serializeCredentialUpdate(() => this.#revoke(reason));
  }

  async #revoke(reason: "disabled" | "permission-denied" | "sign-out") {
    const snapshot = await this.#snapshot();
    if (!snapshot.state.birthCertificate) return null;
    if (snapshot.state.pushTokenSecret) {
      await this.#clearPushTokenSecret({
        pushTokenSecretPath: snapshot.state.pushTokenSecret.path,
        pushTokenSecretUpdatedOffset: snapshot.state.pushTokenSecret.updatedOffset,
      });
    }
    const [event] = await this.#stream.append({
      type: "events.iterate.com/device/revoked",
      idempotencyKey: `device/revoked:${snapshot.state.tokenUpdatedOffset}:${reason}`,
      payload: { reason },
    });
    await this.#waitUntilProcessed(event!.offset);
    return event!;
  }

  async describe(): Promise<DeviceDescription> {
    return describeDeviceState((await this.#snapshot()).state, this.#deviceId);
  }

  /**
   * The facet-hosted device processor's `clearPushToken` dep door: credential
   * updates must stay serialized against enroll/revoke on this DO's one
   * chain, so the facet dials here instead of clearing the Secret itself.
   */
  processorClearPushToken(input: {
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
  }): Promise<boolean> {
    return this.#serializeCredentialUpdate(() => this.#clearPushTokenSecret(input));
  }

  async #snapshot() {
    // UNBORN streams: before enrollment commits, the device's facet
    // subscription does not exist and the Stream DO's facade refuses the
    // name (reads must never materialize a facet). Substitute the unborn
    // shape the facade used to serve: the schema-default fold.
    try {
      return await (await this.#processorFacade()).snapshot();
    } catch (error) {
      if (!isUnconfiguredSubscriptionError(error)) throw error;
      return {
        offset: 0,
        state: DeviceProcessorContract.stateSchema.parse(
          {},
        ) as ProcessorState<DeviceProcessorContract>,
      };
    }
  }

  async #waitUntilProcessed(offset: number) {
    // The offset wait self-pulls and owns the complete read-your-writes
    // timeout. Do not put an unbounded catch-up RPC in front of it.
    await (
      await this.#processorFacade()
    ).waitUntilProcessed({
      offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  get #pushTokenSecretPath(): string {
    return `/secrets/devices/${this.#deviceId}/expo-push-token`;
  }

  #pushTokenSecret(path: string) {
    return this.env.SECRET.getByName(
      DurableObjectNameCodec.stringify({ path, projectId: this.#name.projectId }),
    );
  }

  async #putPushTokenSecret(token: string): Promise<number> {
    const secret = this.#pushTokenSecret(this.#pushTokenSecretPath);
    const current = await secret.describe();
    const input = { egress: { urls: [EXPO_PUSH_ORIGIN] }, material: token };
    const event = current.created ? await secret.update(input) : await secret.create(input);
    return event.offset;
  }

  async #clearPushTokenSecret(input: {
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
  }): Promise<boolean> {
    const secret = this.#pushTokenSecret(input.pushTokenSecretPath);
    return await secret.clearMaterialIfUpdatedOffset({
      expectedUpdatedOffset: input.pushTokenSecretUpdatedOffset,
    });
  }

  #serializeCredentialUpdate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#credentialUpdates.then(work);
    this.#credentialUpdates = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** The device's public projection — snapshots and live state leave the
 * platform as this DESCRIPTION, never the raw fold. Shared with the facet
 * host (src/domains/processor-facet-durable-object.ts) and the itx relay's publicState. */
export function describeDeviceState(
  state: ProcessorState<DeviceProcessorContract>,
  deviceId: string,
): DeviceDescription {
  const config = state.birthCertificate?.config;
  return {
    appVersion: config?.appVersion || null,
    created: !!config,
    deviceId,
    label: config?.label || null,
    lastNotificationOpenedAt: state.lastNotificationOpenedAt,
    notificationsStatus: state.revokedAt ? "revoked" : config?.notificationsStatus || null,
    ownerId: config?.ownerId || null,
    platform: config?.platform || null,
    revokedAt: state.revokedAt,
  };
}

/** Parse the device id out of a `/devices/<id>` stream path (throws on
 * anything else) — shared with the facet host's family dispatch. */
export function deviceIdFromPath(path: string): string {
  const match = /^\/devices\/([A-Za-z0-9_-]+)$/.exec(path);
  if (!match) throw new Error(`invalid device stream path ${path}`);
  return match[1]!;
}

function assertEnrollInput(input: DeviceEnrollInput & { ownerId: string }) {
  if (!/^(Exponent|Expo)PushToken\[[^\]]+\]$/.test(input.expoPushToken)) {
    throw new Error("device enrollment requires an Expo push token");
  }
  if (!input.appVersion.trim() || !input.label.trim() || !input.ownerId.trim()) {
    throw new Error("device enrollment requires appVersion, label, and authenticated owner");
  }
}
