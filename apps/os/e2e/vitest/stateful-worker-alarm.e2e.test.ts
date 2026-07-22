import { expect, test } from "vitest";
import type {
  DynamicWorkerCapability,
  DynamicWorkerRef,
} from "../../src/domains/workers/schemas.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Stateful dynamic workers are hosted as workerd FACETS, and facet storage
// has no alarms — the platform Durable Object hosting the facet owns the real
// alarm on its behalf (setAlarm/getAlarm on the worker capability), and its
// fire is delivered into the worker class's own `alarm()` method. This test
// drives the whole loop: arm through the reserved verb, read the armed time
// back, FAIL the first delivery on purpose (proving a throwing userspace
// handler rethrows into the platform's native alarm retry), see the retried
// fire land with its AlarmInvocationInfo and consume the alarm, disarm an
// armed alarm and prove it never fires — then SELF-ARM: the worker arms
// through its own native `this.ctx.storage.setAlarm`, which only works if
// the host delivered the worker's own ref (the platform bootstrap the SDK's
// alarm shim dials through), and that fire lands too.
test(
  "a stateful dynamic worker's alarm fires into its own alarm() method, with native retry",
  { timeout: 180_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects
      .get(`worker-alarm-${crypto.randomUUID().slice(0, 8)}`)
      .create({});
    await project.projectId;

    const ref: DynamicWorkerRef = {
      className: "AlarmProbe",
      durableWorkerKey: `alarm-probe-${crypto.randomUUID()}`,
      path: "/",
      // BUNDLED inline source (no `bundle: false`): the probe extends
      // IterateDurableObject — fires are delivered through the worker's
      // `invokeCapability` dispatcher, because workerd reserves `alarm` as
      // an RPC method name, and the SDK base class carries that dispatcher.
      // Like every bundled package import, the SDK is declared in the inline
      // source's package.json. Preview builds replace this moving main spec
      // with the deployment's exact APP_CONFIG_ITERATE_SDK_PACKAGE_SPEC.
      source: {
        createWorker: {
          entryPoint: "alarm-probe.js",
          files: {
            type: "inline",
            files: {
              "package.json": JSON.stringify({
                dependencies: {
                  iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
                },
              }),
              "alarm-probe.js": `
                import { IterateDurableObject } from "iterate/sdk";

                export class AlarmProbe extends IterateDurableObject {
                  async alarm(alarmInfo) {
                    if (this.ctx.storage.kv.get("failedOnce") === undefined) {
                      this.ctx.storage.kv.put("failedOnce", true);
                      throw new Error("first fire fails on purpose (retry-path proof)");
                    }
                    this.ctx.storage.kv.put("fires", (this.ctx.storage.kv.get("fires") ?? 0) + 1);
                    this.ctx.storage.kv.put("lastAlarmInfo", alarmInfo ?? null);
                  }

                  async report() {
                    return {
                      fires: this.ctx.storage.kv.get("fires") ?? 0,
                      lastAlarmInfo: this.ctx.storage.kv.get("lastAlarmInfo") ?? null,
                    };
                  }

                  // The native shape a worker actually writes: arm your own
                  // alarm from a handler with the standard storage API.
                  async armSelf(inMs) {
                    await this.ctx.storage.setAlarm(Date.now() + inMs);
                    return this.ctx.storage.getAlarm();
                  }
                }
              `,
            },
          },
        },
      },
      type: "stateful",
    };
    // The cast pins the platform verbs (setAlarm/getAlarm/kill/Disposable)
    // to the real public type; capnweb's stub wrapper defeats direct
    // assignment, hence `as unknown` (the e2e idiom).
    using probe = project.workers.get(ref) as unknown as DynamicWorkerCapability<{
      armSelf(inMs: number): Promise<number | null>;
      report(): Promise<{ fires: number; lastAlarmInfo: { isRetry?: boolean } | null }>;
    }>;

    // Nothing armed on a fresh worker.
    expect(await probe.getAlarm()).toBeNull();
    expect(await probe.report()).toMatchObject({ fires: 0 });

    // Arm with enough lead that the readback races nothing, then wait for
    // the delivery: attempt one throws in the probe, the platform retries
    // with backoff, attempt two records the fire.
    const atMs = Date.now() + 5_000;
    await probe.setAlarm(atMs);
    expect(await probe.getAlarm()).toBe(atMs);
    await expect
      .poll(async () => (await probe.report()).fires, { interval: 500, timeout: 90_000 })
      .toBe(1);
    // The successful fire was the RETRY of the failed first attempt, carried
    // the platform's invocation info across the facet hop, and consumed the
    // alarm, native-style.
    expect(await probe.report()).toMatchObject({ lastAlarmInfo: { isRetry: true } });
    expect(await probe.getAlarm()).toBeNull();

    // Disarm an armed alarm: it reads back null and the due time passes
    // without a fire.
    const disarmAtMs = Date.now() + 8_000;
    await probe.setAlarm(disarmAtMs);
    await probe.setAlarm(null);
    expect(await probe.getAlarm()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, disarmAtMs + 3_000 - Date.now()));
    expect(await probe.report()).toMatchObject({ fires: 1 });

    // Self-addressed arming: the worker arms with the NATIVE storage API —
    // no ref anywhere in its code — which only resolves if the host
    // delivered the worker's own identity. Both alarm views agree, and the
    // fire lands.
    const selfArmed = await probe.armSelf(3_000);
    expect(selfArmed).toEqual(expect.any(Number));
    expect(await probe.getAlarm()).toBe(selfArmed);
    await expect
      .poll(async () => (await probe.report()).fires, { interval: 500, timeout: 90_000 })
      .toBe(2);
  },
);
