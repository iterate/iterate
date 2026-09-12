import {
  installVoiceAgentFromSource,
  type VoiceAgentEntrypointRef,
  type VoiceAgentRpc,
  type VoiceAgentWorkerSource,
  VOICE_AGENT_SOURCE_FILES,
} from "@iterate-com/voice-agent";
import { configureIterateSession, connectItx, disconnectIterateSession } from "iterate/client";
import { z } from "zod";
import faceSource from "../../../packages/voice-agent/src/face.ts?raw";
import refSource from "../../../packages/voice-agent/src/ref.ts?raw";
import setupOptionsSource from "../../../packages/voice-agent/src/setup-options.ts?raw";
import visemeModelSource from "../../../packages/voice-agent/src/viseme-model.generated.ts?raw";
import visemeSource from "../../../packages/voice-agent/src/viseme.ts?raw";
import voiceAgentSource from "../../../packages/voice-agent/src/voice-agent.ts?raw";
import workerSource from "../../../packages/voice-agent/src/worker.ts?raw";

const kitGuestFile = "kit-voice-agent.ts";
const kitSourceDirectory = "kit-voice-agent";
const VoiceSetupInput = z.object({
  baseUrl: z.string().url(),
  projectSlug: z.string().min(1),
  projectApiKey: z.string().min(1),
  deviceId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
});
const ExistingVoiceState = z.object({
  instructions: z.string().default(""),
  backend: z.object({ model: z.string().optional() }).default({}),
  call: z
    .object({ activation: z.string().min(1), conversationId: z.string().min(1) })
    .nullable()
    .default(null),
});

const kitSource: VoiceAgentWorkerSource = {
  createWorker: {
    entryPoint: kitGuestFile,
    files: { repoPath: "/repos/config", type: "repo" },
  },
};
const kitEntrypointRef: VoiceAgentEntrypointRef = {
  path: "/",
  source: kitSource,
  type: "stateless",
};

const kitVoiceAgentSources = {
  "worker.ts": workerSource,
  "voice-agent.ts": voiceAgentSource,
  "face.ts": faceSource,
  "ref.ts": refSource,
  "setup-options.ts": setupOptionsSource,
  "viseme.ts": visemeSource,
  "viseme-model.generated.ts": visemeModelSource,
} satisfies Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>;

/** A source change must create a new durable facet rather than reuse a warm old bundle. */
export async function kitFacetKeyForSources(
  sources: Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>,
): Promise<string> {
  const bundle = VOICE_AGENT_SOURCE_FILES.map((file) => `${file}\0${sources[file]}`).join("\0");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bundle));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `kit-voice-agent-facet-${hash}`;
}

function kitSourcesForFacet(
  facetKey: string,
): Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string> {
  const guestLiteral = 'export const VOICE_AGENT_GUEST_FILE = "voice-agent.ts";';
  const facetLiteral = 'durableWorkerKey: "voice-agent-facet",';
  if (refSource.split(guestLiteral).length !== 2 || refSource.split(facetLiteral).length !== 2) {
    throw new Error("Kit voice source no longer has the expected worker reference literals.");
  }
  return {
    ...kitVoiceAgentSources,
    "ref.ts": refSource
      .replace(guestLiteral, `export const VOICE_AGENT_GUEST_FILE = "${kitGuestFile}";`)
      .replace(facetLiteral, `durableWorkerKey: "${facetKey}",`),
  };
}

interface PreparedDeviceVoice {
  projectId: string;
  streamPath: string;
}

/** Install this build's isolated guest and prove its board stream is ready. */
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

    const stream = project.streams.get(streamPath);
    const subscription = stream.subscriptions.get("voice-agent");
    const configured = await subscription.describe();
    const existing =
      configured === null
        ? ExistingVoiceState.parse({})
        : ExistingVoiceState.parse((await subscription.processor.getRuntimeState()).snapshot.state);
    if (existing.call) {
      throw new Error(
        "This device stream has an active call. End it before changing its voice setup.",
      );
    }

    const facetKey = await kitFacetKeyForSources(kitVoiceAgentSources);
    await installVoiceAgentFromSource(project.repo, kitSourcesForFacet(facetKey), {
      guestFile: kitGuestFile,
      sourceDirectory: kitSourceDirectory,
      preservePublishedVoiceAgentDependency: true,
      message: "kit: install this build's isolated voice agent",
    });

    /* `workers.get` is dynamically typed by the platform. This local entrypoint
     * is written above from the same current source, so its RPC contract is VoiceAgentRpc. */
    const voiceAgent = project.workers.get(kitEntrypointRef) as unknown as VoiceAgentRpc;
    const result = await voiceAgent.setupVoiceAgent({
      streamPath,
      instructions: existing.instructions,
      backend: existing.backend,
      visemes: prepared.deviceId === "waveshare",
    });
    return { projectId: identity.projectId, streamPath: result.streamPath };
  } finally {
    disconnectIterateSession();
  }
}
