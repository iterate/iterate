// One loaded WorkerEntrypoint behind the native Worker → DO → WorkerLoader fetch chain.
// The client-visible contract is healthy; the native close outcome is not yet explained.
// See docs/v4-native-websocket-close-repro.md. Run explicitly against the V4 deployment
// with its existing Doppler Cloudflare credentials; this is not a local-runtime test.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket as TailWebSocket } from "undici";
import { z } from "zod";
import { expressionUrl, freshCtx, workerUrl, wsRoundTrip } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

const NativeRecord = z.object({
  scriptName: z.literal("iterate-v4-simplification"),
  entrypoint: z.string().optional(),
  eventTimestamp: z.number(),
  outcome: z.enum(["ok", "exception"]),
  exceptions: z.array(z.unknown()).length(0),
  logs: z.array(z.unknown()).length(0),
});
type NativeRecord = z.infer<typeof NativeRecord>;

describe.skipIf(!process.env.WORKER_BASE_URL?.startsWith("https://"))(
  "native WebSocket close telemetry (deployed only)",
  () => {
    let tail: TailWebSocket | undefined;
    let tailId: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let readinessPoll: ReturnType<typeof setInterval> | undefined;
    let apiUrl: string;
    let token: string;
    let records: NativeRecord[] = [];

    async function tailRequest(method: "POST" | "DELETE", body?: unknown) {
      const response = await fetch(`${apiUrl}${tailId ? `/${tailId}` : ""}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Cloudflare tail ${method}: HTTP ${response.status}`);
      return z
        .object({ success: z.literal(true), result: z.unknown() })
        .parse(await response.json()).result;
    }

    async function deployedVersion() {
      const response = await fetch(workerUrl("/version"), { signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      return z.uuid().parse((await response.text()).trim().split(/\s+/).at(-1));
    }

    // All prerequisites deliberately live OUTSIDE test.fails. Missing telemetry, a changed
    // deployment, unexpected error details, or a broken echo must remain ordinary failures.
    beforeAll(async () => {
      expect(new URL(workerUrl("/")).origin).toBe("https://v4.iterate2.app");
      token = z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN);
      const account = z
        .literal("04b3b57291ef2626c6a8daa9d47065a7")
        .parse(process.env.CLOUDFLARE_ACCOUNT_ID);
      apiUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/iterate-v4-simplification/tails`;
      const version = await deployedVersion();
      const created = z.object({ id: z.string().min(1), url: z.url() }).parse(
        await tailRequest("POST", {
          filters: [{ scriptVersion: version }],
        }),
      );
      tailId = created.id;
      const marker = `/expression/__native_ws_close_${crypto.randomUUID()}`;
      const readyPath = `/__native_tail_ready_${crypto.randomUUID()}`;
      let resolveObservation!: (value: NativeRecord[] | Error) => void;
      const observation = new Promise<NativeRecord[] | Error>((resolve) => {
        resolveObservation = resolve;
      });
      let resolveOpened!: (value?: Error) => void;
      const opened = new Promise<void | Error>((resolve) => {
        resolveOpened = resolve;
      });
      let resolveControl!: (value?: Error) => void;
      const controlObserved = new Promise<void | Error>((resolve) => {
        resolveControl = resolve;
      });
      tail = new TailWebSocket(created.url, "trace-v1");
      tail.binaryType = "arraybuffer";
      tail.addEventListener("open", () => {
        tail?.send(JSON.stringify({ debug: false }));
        resolveOpened();
      });
      tail.addEventListener("error", () => {
        resolveOpened(new Error("Cloudflare tail connection failed"));
        resolveControl(new Error("Cloudflare tail connection failed"));
        resolveObservation(new Error("Cloudflare tail connection failed"));
      });
      tail.addEventListener("message", (message) => {
        try {
          const data: unknown = message.data;
          const text =
            data instanceof ArrayBuffer ? new TextDecoder().decode(data) : z.string().parse(data);
          const event: unknown = JSON.parse(text);
          const request = z
            .object({
              event: z.object({ request: z.object({ url: z.string(), method: z.string() }) }),
            })
            .safeParse(event);
          if (!request.success) return;
          const path = new URL(request.data.event.request.url).pathname;
          if (path === readyPath) {
            const control = NativeRecord.safeParse(event);
            resolveControl(
              control.success && control.data.outcome === "ok"
                ? undefined
                : new Error("HTTP control has unhealthy native telemetry"),
            );
            return;
          }
          if (path !== marker) return;
          expect(request.data.event.request.method).toBe("GET");
          // Retain only this request's reduced record. Never print tail URLs, request headers,
          // cookies, or arbitrary exception/log payloads, including on schema validation failure.
          const parsed = NativeRecord.safeParse(event);
          if (!parsed.success)
            throw new Error("Native upgrade outcome differs from the known failure");
          // The public outer request independently exhibits the defect. DO tail records are
          // not delivered reliably; the broader parent/DO audit remains a separate release gate.
          if (parsed.data.entrypoint !== undefined) return;
          records.push(parsed.data);
          resolveObservation(records);
        } catch {
          resolveControl(new Error("Native tail record failed the strict reproduction guard"));
          resolveObservation(new Error("Native tail record failed the strict reproduction guard"));
        }
      });
      deadline = setTimeout(() => {
        resolveOpened(new Error("Cloudflare tail did not open within 60s"));
        resolveControl(new Error("Cloudflare tail did not observe the HTTP control within 60s"));
        resolveObservation(
          new Error(`Expected the outer native upgrade record within 60s; got ${records.length}`),
        );
        tail?.close();
      }, 60_000);
      const connection = await opened;
      if (connection instanceof Error) throw connection;

      // Cloudflare's tail can connect before its log subscription is active. Poll a read-only
      // banner route until THIS tail actually sees it; do not repeat the WebSocket under test.
      let checkingReady = false;
      const checkReady = async () => {
        if (checkingReady) return;
        checkingReady = true;
        try {
          const response = await fetch(workerUrl(readyPath), {
            signal: AbortSignal.timeout(5_000),
          });
          expect(response.status).toBe(200);
          await response.text();
        } catch {
          resolveControl(new Error("Tail readiness HTTP probe failed"));
        } finally {
          checkingReady = false;
        }
      };
      await checkReady();
      readinessPoll = setInterval(() => void checkReady(), 1_000);
      const controlTelemetry = await controlObserved;
      clearInterval(readinessPoll);
      if (controlTelemetry instanceof Error) throw controlTelemetry;
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        resolveObservation(new Error("Expected the outer native upgrade record within 60s"));
        tail?.close();
      }, 60_000);

      const ctx = freshCtx("native_ws_close");
      const expression = `itx.workers.get({ source: ${JSON.stringify(SOURCES.site)} })`;
      const controlUrl = new URL(expressionUrl(ctx, expression));
      controlUrl.pathname = `${marker}/control`;
      const control = await fetch(controlUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      expect(control.status).toBe(200);
      expect(await control.text()).toContain("hello from a dynamic web capability");
      const upgrade = new URL(expressionUrl(ctx, expression, "ws"));
      upgrade.pathname = marker;
      expect(await wsRoundTrip(upgrade.toString(), "native-close-repro")).toEqual({
        opened: true,
        echo: "site-echo:native-close-repro",
        closeCode: 1000,
      });
      const observed = await observation;
      if (observed instanceof Error) throw observed;
      records = observed;
      clearTimeout(deadline);
      clearInterval(readinessPoll);
      tail.close();
      expect(await deployedVersion()).toBe(version);
      expect(records).toHaveLength(1);
      expect(records[0]?.entrypoint).toBeUndefined();
      console.info("native-ws-close-proof", JSON.stringify({ version, records }));
    }, 180_000);

    afterAll(async () => {
      clearTimeout(deadline);
      clearInterval(readinessPoll);
      tail?.close();
      if (tailId) await tailRequest("DELETE");
    });

    test.fails("a successful echo and normal close leave a healthy native outer outcome", () => {
      expect(records.map((record) => record.outcome)).toEqual(["ok"]);
    });
  },
);
