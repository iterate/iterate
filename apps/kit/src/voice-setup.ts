import {
  installVoiceAgentFromSource,
  type VoiceAgentRpc,
  VOICE_AGENT_SOURCE_FILES,
} from "@iterate-com/voice-agent";
import { configureIterateSession, connectItx, disconnectIterateSession } from "iterate/client";
import { z } from "zod";
import faceSource from "../../../packages/voice-agent/src/face.ts?raw";
import refConfigSource from "../../../packages/voice-agent/src/ref-config.ts?raw";
import refSource from "../../../packages/voice-agent/src/ref.ts?raw";
import setupOptionsSource from "../../../packages/voice-agent/src/setup-options.ts?raw";
import visemeModelSource from "../../../packages/voice-agent/src/viseme-model.generated.ts?raw";
import visemeSource from "../../../packages/voice-agent/src/viseme.ts?raw";
import voiceAgentSource from "../../../packages/voice-agent/src/voice-agent.ts?raw";
import workerSource from "../../../packages/voice-agent/src/worker.ts?raw";
import { findFirmwareDevice } from "./firmware/catalog.ts";

const kitGuestFile = "kit-voice-agent.ts";
const kitSourceDirectory = "kit-voice-agent";
const VoiceSetupInput = z.object({
  baseUrl: z.string().url(),
  projectSlug: z.string().min(1),
  projectApiKey: z.string().min(1),
  deviceId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .refine((deviceId) => findFirmwareDevice(deviceId) !== undefined, "Unsupported voice device."),
});
const kitVoiceAgentSources = {
  "worker.ts": workerSource,
  "voice-agent.ts": voiceAgentSource,
  "face.ts": faceSource,
  "ref.ts": refSource,
  "ref-config.ts": refConfigSource,
  "setup-options.ts": setupOptionsSource,
  "viseme.ts": visemeSource,
  "viseme-model.generated.ts": visemeModelSource,
} satisfies Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>;

interface PreparedDeviceVoice {
  projectId: string;
  streamPath: string;
}

/** Install this build's isolated guest and durably mount its setup RPC for the board. */
export async function prepareDeviceVoice(input: {
  baseUrl: string;
  projectSlug: string;
  projectApiKey: string;
  deviceId: string;
}): Promise<PreparedDeviceVoice> {
  const prepared = VoiceSetupInput.parse(input);
  const streamPath = `/agents/voice/v23/${prepared.deviceId}`;
  configureIterateSession({
    baseUrl: prepared.baseUrl,
    credentials: {
      type: "project-secret",
      projectSlug: prepared.projectSlug,
      secret: prepared.projectApiKey,
    },
  });

  try {
    const project = await connectItx(prepared.projectSlug);
    const [identity, secretDescription] = await Promise.all([
      project.identity(),
      project.secrets.get("/secrets/openai").__describe(),
    ]);
    if (secretDescription.created !== true || secretDescription.hasMaterial !== true) {
      throw new Error("This project needs /secrets/openai before a voice device can be prepared.");
    }

    const install = await installVoiceAgentFromSource(project.repo, kitVoiceAgentSources, {
      guestFile: kitGuestFile,
      sourceDirectory: kitSourceDirectory,
      facetKeyPrefix: "kit-voice-agent-facet",
      preservePublishedVoiceAgentDependency: true,
      message: "kit: install this build's isolated voice agent",
    });

    // `workers.get` is dynamically typed by the platform. The entrypoint was
    // just written from this build's source, whose stateless RPC surface is VoiceAgentRpc.
    const voiceAgent = project.workers.get(install.entrypointRef) as unknown as VoiceAgentRpc;
    const health = await voiceAgent.health();
    if (health.ok !== true || health.projectId !== identity.projectId) {
      throw new Error("The installed voice agent did not pass its project health check.");
    }

    const [mounted] = await project.streams.get("/").append({
      type: "events.iterate.com/capability-host/capability-provided",
      payload: {
        type: "itx-call",
        path: ["voice"],
        expression: ["workers", ["get", install.entrypointRef]],
        flattenNestedPaths: true,
        instructions: "Set up a fresh voice conversation stream for a Kit device.",
      },
    });
    await project.capabilityHosts.get("/").processor.waitUntilProcessed({ offset: mounted.offset });
    return { projectId: identity.projectId, streamPath };
  } finally {
    disconnectIterateSession();
  }
}
