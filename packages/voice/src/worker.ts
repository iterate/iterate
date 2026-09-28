/// <reference path="./markdown.d.ts" />
/**
 * The voice service, explicitly mounted at `itx.voice`, is what
 * a device calls on the button press:
 *
 *   await root.voice.setupVoiceAgent({ streamPath, activation })   // → { streamPath }
 *
 * Normal agent creation establishes the parent link, sandbox and catalog entry. Then the voice
 * processors replace the default agent processor: one append installs their subscriptions and
 * starts the call, so the relay dials the provider before the first microphone frame arrives.
 * The device carries no source or class name: both facets load the project's installed voice
 * source, the one this worker runs (install.ts keeps it in project KV).
 */
import type {} from "@iterate-com/agents";
// registers `itx.agents` on InstalledAppRoots
import { bytesToBase64 } from "@iterate-com/shared/base64";
import type { IterateContextApiWith } from "iterate/api";
import { ConfigWorker, z } from "iterate/sdk";
import type { VoiceApi } from "./api.ts";
import { VOICE_DELEGATE_CONSUMES } from "./events.ts";
import { ScreenInfo, ScreenImageInput, renderScreenPixels } from "./screen.ts";
import SCREEN_CONTEXT from "./screen-context.md";

/** What install.ts writes at `voice/runtime`: the installed source and its content hash, which the
 *  loader caches an isolate under, so a new source is a new key. */
const VoiceRuntime = z.object({
  cacheKey: z.string().min(1),
  source: z.record(z.string(), z.string()),
});

export default class VoiceWorker extends ConfigWorker implements VoiceApi {
  async health() {
    const { projectId, cacheKey } = await this.withItx(async (itx) => ({
      ...(await itx.whoami()),
      ...(await installedRuntime(itx)),
    }));
    return { ok: true as const, projectId, cacheKey };
  }

  /** Render to the resolution and pixel format advertised by the target. */
  async setImage(rawInput: Parameters<VoiceApi["setImage"]>[0]) {
    const input = ScreenImageInput.parse(rawInput);
    const startedAt = Date.now();
    // One round trip for the whole upload, bounded by the screen's refreshTimeoutMs.
    return this.withItx(async (scope) => {
      // ITX mounts are dynamic remote capabilities. Validate their returned
      // metadata at the boundary; this interface describes the methods we call.
      const itx = scope as unknown as {
        browser: {
          quickAction(action: "screenshot", options: Record<string, unknown>): Promise<Uint8Array>;
        };
        clients: Record<
          string,
          {
            screen: {
              info(): Promise<unknown>;
              setImage(
                input: null | { uploadId: number; offset: number; format: string; data: string },
              ): Promise<unknown>;
            };
          }
        >;
      };
      const screen = itx.clients[input.device]!.screen;
      const info = ScreenInfo.parse(await screen.info());
      if (!input.image) {
        const transferStartedAt = Date.now();
        await screen.setImage(null);
        const transferMs = Date.now() - transferStartedAt;
        return {
          shown: false as const,
          bytes: 0,
          renderMs: 0,
          transferMs,
          totalMs: Date.now() - startedAt,
        };
      }
      const format = input.image.format || info.preferredFormat;
      if (!info.formats.includes(format)) throw new Error(`Screen does not support ${format}`);
      const renderStartedAt = Date.now();
      const png = await itx.browser.quickAction("screenshot", {
        html: input.image.html,
        viewport: { width: info.width, height: info.height, deviceScaleFactor: 1 },
        // A screenshot can succeed even when an <img> is a broken-link icon.
        // Gate capture on decoded images and loaded fonts, with a bounded wait.
        addScriptTag: [
          {
            content: `
          document.documentElement.removeAttribute("data-iterate-screen-assets");
          Promise.all([
            ...Array.from(document.images, image => { image.loading = "eager"; return image.decode(); }),
            document.fonts.ready,
          ]).then(
            () => document.documentElement.setAttribute("data-iterate-screen-assets", "ready"),
            () => document.documentElement.setAttribute("data-iterate-screen-assets", "failed"),
          );
        `,
          },
        ],
        waitForSelector: { selector: '[data-iterate-screen-assets="ready"]', timeout: 5000 },
        screenshotOptions: { type: "png", fullPage: false },
      });
      const renderMs = Date.now() - renderStartedAt;
      const bitmap = renderScreenPixels(
        png instanceof Uint8Array ? png : new Uint8Array(png),
        info,
        format,
      );
      const uploadId = Math.floor(Math.random() * 0x7fffffff);
      const transferStartedAt = Date.now();
      let slowestChunkMs = 0;
      for (let offset = 0; offset < bitmap.length; offset += info.maxChunkBytes) {
        const expected = Math.min(offset + info.maxChunkBytes, bitmap.length);
        const sentAt = Date.now();
        const answer = screen.setImage({
          uploadId,
          format,
          offset,
          data: bytesToBase64(bitmap.subarray(offset, expected)),
        });
        // The chunk that completes the frame is answered once the panel shows it, and fails if the
        // refresh fails (apps/kit/firmware/components/capabilities/src/screen.c). Its bound is the
        // screen's refreshTimeoutMs on top of the slowest round trip an earlier chunk took.
        let refreshDeadline: ReturnType<typeof setTimeout> | undefined;
        const acknowledged = await (expected < bitmap.length
          ? answer
          : Promise.race([
              answer,
              new Promise<never>((_, reject) => {
                refreshDeadline = setTimeout(
                  () => reject(new Error("Screen refresh timed out")),
                  slowestChunkMs + info.refreshTimeoutMs,
                );
              }),
            ]).finally(() => clearTimeout(refreshDeadline)));
        slowestChunkMs = Math.max(slowestChunkMs, Date.now() - sentAt);
        if (acknowledged !== expected) {
          throw new Error(
            `screen acknowledged ${String(acknowledged)} bytes; expected ${String(expected)}`,
          );
        }
      }
      const transferMs = Date.now() - transferStartedAt;
      return {
        shown: true as const,
        width: info.width,
        height: info.height,
        format,
        bytes: bitmap.length,
        renderMs,
        transferMs,
        totalMs: Date.now() - startedAt,
      };
    });
  }

  /** The press. `activation` is the device's call identity: the call starts under it at boot and
   * the microphone frames carry it. */
  async setupVoiceAgent(options: Parameters<VoiceApi["setupVoiceAgent"]>[0]) {
    const streamPath = options.streamPath || `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(`voice streamPath must be absolute; received ${JSON.stringify(streamPath)}`);
    }
    const deviceMatch = /^\/agents\/voice\/v23\/([A-Za-z0-9_-]+)\//.exec(streamPath);
    const screenDevice =
      options.screen === true && deviceMatch?.[1] ? deviceMatch[1].replaceAll("-", "_") : undefined;
    return this.withItx(async (scope) => {
      // `itx.agents` is the rewrite rule the agents app mounts, which install.ts requires first.
      const itx = scope as IterateContextApiWith<"agents">;
      const { cacheKey, source } = await installedRuntime(itx);
      // Normal agent creation establishes the creator link and script sandbox before
      // either loaded voice processor needs project code, egress or tools.
      await itx.agents.create(streamPath);
      const conversation = itx.cd(streamPath);
      await conversation.processors.disable("agent");
      await conversation.append(
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            name: "voice-agent",
            target: [
              "itx",
              "facets",
              ["get", "voice-agent", { source, cacheKey, className: "VoiceAgentDurableObject" }],
              "processEventBatch",
            ],
            /* Every durable event, plus the two ephemeral types a processor only sees by name. */
            consumes: [
              "*",
              "events.iterate.com/voice-agent/mic-frame",
              "events.iterate.com/voice-agent/keepalive",
            ],
          },
        },
        {
          type: "events.iterate.com/itx/subscription-configured",
          payload: {
            /* Not "agent": that is the normal agent processor this press disabled above. */
            name: "voice-delegate",
            target: [
              "itx",
              "facets",
              [
                "get",
                "voice-delegate",
                { source, cacheKey, className: "VoiceDelegateDurableObject" },
              ],
              "processEventBatch",
            ],
            /* The delegate contract's own list (events.ts): context, the relay's delegations, and
             * its own answers (to settle the pending fold). */
            consumes: [...VOICE_DELEGATE_CONSUMES],
          },
        },
        {
          type: "events.iterate.com/voice-agent/call-started",
          idempotencyKey: `voice-agent/call:${options.activation}`,
          payload: {
            activation: options.activation,
            conversationId: `conv_${options.activation}`,
          },
        },
        ...(screenDevice
          ? [
              {
                type: "events.iterate.com/agent/context-added",
                idempotencyKey: `voice-agent/screen-context:${options.activation}`,
                payload: {
                  role: "developer",
                  content: SCREEN_CONTEXT.replaceAll("{{DEVICE}}", screenDevice!),
                },
              },
            ]
          : []),
      );
      return { streamPath };
    });
  }
}

/** The voice source the project installed (install.ts). */
async function installedRuntime(itx: { kv: { get(key: string): Promise<string | null> } }) {
  const stored = await itx.kv.get("voice/runtime");
  if (!stored) throw new Error("Voice is not installed: project KV has no voice/runtime");
  return VoiceRuntime.parse(JSON.parse(stored));
}
