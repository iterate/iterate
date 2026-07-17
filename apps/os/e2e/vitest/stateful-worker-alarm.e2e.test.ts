import { expect, test } from "vitest";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Stateful dynamic workers are hosted as workerd FACETS, and facet storage
// has no alarms — the platform Durable Object hosting the facet owns one real
// alarm on its behalf (setAlarm/getAlarm on the worker capability), and its
// fire replays into the worker class's own `alarm()` method. This test drives
// that whole loop: arm through the reserved verb, observe the armed time,
// wait for the fire to land in userspace (with the platform's
// AlarmInvocationInfo), and see the alarm consumed afterwards — plus a
// disarm that never fires. The probe records fires in its facet storage, so
// a fire also proves the parent booted the worker recipe persisted at
// arm time on a cold path.
test(
  "a stateful dynamic worker's alarm fires into its own alarm() method",
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({
      slug: `worker-alarm-${crypto.randomUUID().slice(0, 8)}`,
    });
    await project.projectId;

    const ref: DynamicWorkerRef = {
      className: "AlarmProbe",
      durableWorkerKey: `alarm-probe-${crypto.randomUUID()}`,
      path: "/",
      // BUNDLED inline source (not `inlineJsSource`, which sets
      // `bundle: false`): the probe extends IterateDurableObject — the
      // platform delivers alarm fires through the worker's
      // `invokeCapability` dispatcher, because workerd reserves `alarm` as
      // an RPC method name, and the SDK base class carries that dispatcher.
      // The `iterate/sdk` virtual module only exists in bundled builds.
      source: {
        files: {
          type: "inline",
          files: {
            "alarm-probe.js": `
                import { IterateDurableObject } from "iterate/sdk";

                export class AlarmProbe extends IterateDurableObject {
                  async alarm(alarmInfo) {
                    this.ctx.storage.kv.put("fires", (this.ctx.storage.kv.get("fires") ?? 0) + 1);
                    this.ctx.storage.kv.put("lastAlarmInfo", alarmInfo ?? null);
                  }

                  async report() {
                    return {
                      fires: this.ctx.storage.kv.get("fires") ?? 0,
                      lastAlarmInfo: this.ctx.storage.kv.get("lastAlarmInfo") ?? null,
                    };
                  }
                }
              `,
          },
        },
        options: { entryPoint: "alarm-probe.js" },
      },
      type: "stateful",
    };
    using probe = project.workers.get(ref) as unknown as {
      getAlarm(): Promise<number | null>;
      report(): Promise<{ fires: number; lastAlarmInfo: unknown }>;
      setAlarm(atMs: number | null): Promise<void>;
    } & Disposable;

    // Nothing armed on a fresh worker.
    expect(await probe.getAlarm()).toBeNull();
    expect(await probe.report()).toMatchObject({ fires: 0 });

    // Arm, read back, and wait for the fire to reach userspace.
    const atMs = Date.now() + 1_500;
    await probe.setAlarm(atMs);
    expect(await probe.getAlarm()).toBe(atMs);
    await expect
      .poll(async () => (await probe.report()).fires, { interval: 500, timeout: 90_000 })
      .toBe(1);
    // The fire carried the platform's alarm invocation info and consumed the
    // alarm, native-style.
    expect(await probe.report()).toMatchObject({ lastAlarmInfo: { isRetry: false } });
    expect(await probe.getAlarm()).toBeNull();

    // Disarm before the fire: the alarm reads back null and never lands.
    await probe.setAlarm(Date.now() + 2_000);
    await probe.setAlarm(null);
    expect(await probe.getAlarm()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await probe.report()).toMatchObject({ fires: 1 });
  },
);
