import { DurableObject } from "cloudflare:workers";
import {
  isStreamOffsetConflictError,
  type ProcessorState,
  type StreamEventInput,
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  LiveStateRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { decryptDevicePushToken, encryptDevicePushToken } from "./device-crypto.ts";
import { DeviceProcessorContract } from "./device-processor-contract.ts";
import { DeviceProcessor } from "./device-processor-implementation.ts";
import { getExpoPushReceipt, sendExpoPushNotification } from "./expo-push-client.ts";
import type { DeviceAppendInput, DeviceDescription, DeviceEnrollInput } from "./types.ts";
import { PUBLIC_DEVICE_EVENT_TYPES } from "./types.ts";

const MAX_ENROLL_ATTEMPTS = 8;
const INGEST_WAIT_TIMEOUT_MS = 15_000;

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
      getReceipt: getExpoPushReceipt,
      repointReceiptAlarm: (atMs) => this.#registry.setAlarmSlice("device-receipts", atMs),
      send: async ({ encryptedPushToken, notification }) => {
        const state = this.#reads.currentState;
        const ownerId = state.birthCertificate?.config.ownerId;
        if (
          ownerId === undefined ||
          state.encryptedPushToken?.offset !== encryptedPushToken.offset
        ) {
          throw new Error("device push token changed before the attempt began");
        }
        const token = await decryptDevicePushToken(
          encryptedPushToken,
          this.env.SECRET_ENCRYPTION_KEY,
          {
            offset: encryptedPushToken.offset,
            ownerId,
            path: this.#name.path,
            projectId: this.#name.projectId,
          },
        );
        return await sendExpoPushNotification({ ...notification, token });
      },
    }),
    { recovery: true },
  );
  readonly #reads = this.#registry.reads(this.#deviceProcessor);
  #enrollments: Promise<void> = Promise.resolve();

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
    const result = this.#enrollments.then(() => this.#enroll(input));
    this.#enrollments = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #enroll(input: DeviceEnrollInput & { ownerId: string }) {
    assertEnrollInput(input);
    for (let attempt = 1; attempt <= MAX_ENROLL_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshot();
      const existingOwner = snapshot.state.birthCertificate?.config.ownerId;
      if (existingOwner !== undefined && existingOwner !== input.ownerId) {
        throw new Error("this device id is already enrolled by another user");
      }
      const offset = snapshot.offset + 1;
      const encryptedPushToken = await encryptDevicePushToken(
        input.expoPushToken,
        this.env.SECRET_ENCRYPTION_KEY,
        {
          offset,
          ownerId: input.ownerId,
          path: this.#name.path,
          projectId: this.#name.projectId,
        },
      );
      try {
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
              offset,
              payload: {
                config: {
                  appVersion: input.appVersion,
                  encryptedPushToken,
                  label: input.label,
                  notificationsStatus: input.notificationsStatus,
                  ownerId: input.ownerId,
                  platform: input.platform,
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
          offset,
          payload: {
            appVersion: input.appVersion,
            encryptedPushToken,
            label: input.label,
            notificationsStatus: input.notificationsStatus,
          },
        } as StreamEventInput);
        await this.#waitUntilProcessed(updated!.offset);
        return describeDeviceState(this.#reads.currentState, this.#deviceId);
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_ENROLL_ATTEMPTS) throw error;
      }
    }
    throw new Error("unreachable device enrollment retry state");
  }

  async append(...events: DeviceAppendInput[]) {
    await this.#assertCreated();
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

  async revoke(ownerId: string, reason: "disabled" | "permission-denied" | "sign-out") {
    const snapshot = await this.#snapshot();
    if (snapshot.state.birthCertificate?.config.ownerId !== ownerId) {
      throw new Error("only the enrolling user can revoke this device");
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

  async #assertCreated() {
    const snapshot = await this.#snapshot();
    if (snapshot.state.birthCertificate === null) throw new Error("device has not been enrolled");
  }

  async #snapshot() {
    await this.#registry.catchUp(DeviceProcessorContract.slug);
    return await this.#reads.snapshot();
  }

  async #waitUntilProcessed(offset: number) {
    await this.#registry.catchUp(DeviceProcessorContract.slug);
    await this.#reads.waitUntilEvent({ offset, timeoutMs: INGEST_WAIT_TIMEOUT_MS });
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
