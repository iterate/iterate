import { DurableObject } from "cloudflare:workers";
import { LiveStateRpcTarget } from "iterate/live-state";
import {
  type ProcessorState,
  type StreamEventInput,
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { DeviceProcessorContract } from "./device-processor-contract.ts";
import { DeviceProcessor, type DevicePushSender } from "./device-processor-implementation.ts";
import { getExpoPushReceipt, sendExpoPushNotification } from "./expo-push-client.ts";
import type { DeviceAppendInput, DeviceDescription, DeviceEnrollInput } from "./types.ts";
import { PUBLIC_DEVICE_EVENT_TYPES } from "./types.ts";

const INGEST_WAIT_TIMEOUT_MS = 15_000;
const EXPO_PUSH_ORIGIN = "https://exp.host";

export class DeviceDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #deviceId = deviceIdFromPath(this.#name.path);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
    getLiveState: (): DeviceDescription =>
      describeDeviceState(this.#reads.currentState, this.#deviceId),
  });
  readonly #deviceProcessor = this.#registry.register(
    new DeviceProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      now: Date.now,
      clearPushToken: (input) =>
        this.#serializeCredentialUpdate(() => this.#clearPushTokenSecret(input)),
      getReceipt: getExpoPushReceipt,
      repointReceiptAlarm: (atMs) => this.#registry.setAlarmSlice("device-receipts", atMs),
      send: async ({ notification, pushTokenSecretPath }): ReturnType<DevicePushSender> => {
        const state: ProcessorState<DeviceProcessorContract> = this.#reads.currentState;
        if (state.pushTokenSecretPath !== pushTokenSecretPath) {
          throw new Error("device push token changed before the attempt began");
        }
        const secret = this.#pushTokenSecret(pushTokenSecretPath);
        return await sendExpoPushNotification({ ...notification, pushTokenSecretPath }, (request) =>
          secret.fetch(request),
        );
      },
    }),
    { recovery: true },
  );
  readonly #reads = this.#registry.reads(this.#deviceProcessor);
  #credentialUpdates: Promise<void> = Promise.resolve();

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#registry.handleAlarm(alarmInfo);
    try {
      await this.#registry.catchUp(DeviceProcessorContract.slug);
      await this.#deviceProcessor.checkReceipts(this.#reads.currentState);
      await this.#registry.catchUp(DeviceProcessorContract.slug);
    } catch (error) {
      await this.#registry.setAlarmSlice("device-receipts", Date.now() + 60_000);
      throw error;
    }
  }

  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(DeviceProcessorContract.slug),
      publicState: (state) => describeDeviceState(state, this.#deviceId),
    });
  }

  get liveState() {
    return new LiveStateRpcTarget<DeviceDescription>(this.#registry);
  }

  enroll(input: DeviceEnrollInput & { ownerId: string }) {
    return this.#serializeCredentialUpdate(() => this.#enroll(input));
  }

  async #enroll(input: DeviceEnrollInput & { ownerId: string }) {
    assertEnrollInput(input);
    const snapshot = await this.#snapshot();
    const existingOwner = snapshot.state.birthCertificate?.config.ownerId;
    const pushTokenSecretUpdatedOffset = await this.#putPushTokenSecret(input.expoPushToken);
    if (existingOwner === undefined) {
      const subscription = buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName: this.ctx.id.name!,
        idempotencyKey: `stream/subscription-configured:${this.ctx.id.name!}#${DeviceProcessorContract.slug}`,
        processor: ["devices", ["get", this.#deviceId], "processor"],
        processorSlug: DeviceProcessorContract.slug,
      });
      const [created, configured] = await this.#stream.append(
        {
          type: "events.iterate.com/device/created",
          idempotencyKey: `device/created:${this.#name.projectId}:${this.#deviceId}`,
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
        } as StreamEventInput,
        subscription,
      );
      await this.#waitUntilProcessed(Math.max(created!.offset, configured!.offset));
      return describeDeviceState(this.#reads.currentState, this.#deviceId);
    }
    const [updated] = await this.#stream.append({
      type: "events.iterate.com/device/push-token-updated",
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
    return describeDeviceState(this.#reads.currentState, this.#deviceId);
  }

  async append(...events: DeviceAppendInput[]) {
    const snapshot = await this.#snapshot();
    if (snapshot.state.birthCertificate === null) throw new Error("device has not been enrolled");
    const parsed = events.map((event) => {
      const consumed = DeviceProcessorContract.parseConsumedInput(event);
      if (!PUBLIC_DEVICE_EVENT_TYPES.has(consumed.type as never)) {
        throw new Error(`device append does not accept lifecycle event ${consumed.type}`);
      }
      return consumed as DeviceAppendInput;
    });
    const committed = await this.#stream.append(...(parsed as StreamEventInput[]));
    if (committed.length > 0) {
      await this.#waitUntilProcessed(Math.max(...committed.map((event) => event.offset)));
    }
    return committed;
  }

  revoke(reason: "disabled" | "permission-denied" | "sign-out") {
    return this.#serializeCredentialUpdate(() => this.#revoke(reason));
  }

  async #revoke(reason: "disabled" | "permission-denied" | "sign-out") {
    const snapshot = await this.#snapshot();
    if (snapshot.state.birthCertificate === null) throw new Error("device has not been enrolled");
    if (snapshot.state.pushTokenSecretUpdatedOffset !== null) {
      await this.#clearPushTokenSecret({
        pushTokenSecretPath: this.#pushTokenSecretPath,
        pushTokenSecretUpdatedOffset: snapshot.state.pushTokenSecretUpdatedOffset,
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

  async #snapshot() {
    await this.#registry.catchUp(DeviceProcessorContract.slug);
    return await this.#reads.snapshot();
  }

  async #waitUntilProcessed(offset: number) {
    await this.#registry.catchUp(DeviceProcessorContract.slug);
    await this.#reads.waitUntilEvent({ offset, timeoutMs: INGEST_WAIT_TIMEOUT_MS });
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

function describeDeviceState(
  state: ProcessorState<DeviceProcessorContract>,
  deviceId: string,
): DeviceDescription {
  const config = state.birthCertificate?.config;
  return {
    appVersion: config?.appVersion || null,
    created: config !== undefined,
    deviceId,
    label: config?.label || null,
    lastNotificationOpenedAt: state.lastNotificationOpenedAt,
    notificationsStatus: state.revokedAt !== null ? "revoked" : config?.notificationsStatus || null,
    ownerId: config?.ownerId || null,
    platform: config?.platform || null,
    revokedAt: state.revokedAt,
  };
}

function deviceIdFromPath(path: string): string {
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
