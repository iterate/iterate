// Literal no-cloud voice proof: local worker -> loopback fake provider ->
// Cap'n Web stream -> synthetic microphone and speaker accounting.
//
//   pnpm cli voicelab local --project voice-test --say "local proof"
import fs from "node:fs";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { client, type ClientOptions } from "./client.ts";
import { connectProject } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import {
  LOCAL_FAKE_ANSWER_TRANSCRIPT,
  LOCAL_FAKE_SPEAKER_BYTES,
  startLocalFakeGrok,
} from "./local-fake-grok.ts";
import { withRpcResult } from "./rpc-ownership.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";

export interface LocalOptions extends Omit<
  ClientOptions,
  "detached" | "grokBaseUrl" | "mic" | "workerUrl"
> {
  /** Retain the asserted proof as JSON. */
  out?: string;
}

interface VoiceAgentHealth {
  health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }>;
}

/** Prove the entire local path without xAI, a tunnel, or any other cloud provider. */
export async function local(options: LocalOptions) {
  const fake = await startLocalFakeGrok();
  try {
    using itx = await connectProject(options);
    const install = await installVoiceAgent(itx);
    // The static config-repo template cannot describe a guest installed at
    // runtime. This exact ref is the just-installed voice-agent commit above,
    // whose health method is the narrow capability declared here.
    using voiceAgent = itx.workers.get(
      voiceAgentEntrypointRef,
    ) as unknown as DynamicWorkerCapability<VoiceAgentHealth>;
    const health = await withRpcResult(
      voiceAgent.health(),
      ({ ok, projectId, xaiSecretReady }) => ({ ok, projectId, xaiSecretReady }),
    );
    if (health.ok !== true) throw new Error("local voice-agent health check failed");

    const summary = await client({
      ...options,
      detached: true,
      grokBaseUrl: fake.url,
      say: options.say ?? "This utterance is handled without a cloud voice provider.",
      turns: options.turns ?? 1,
    });
    const session = fake.sessions.at(-1);
    if (session === undefined) throw new Error("the worker never dialled the local provider");
    if (session.micBytes === 0) throw new Error("the local provider received no microphone bytes");
    if (session.speakerBytes !== LOCAL_FAKE_SPEAKER_BYTES) {
      throw new Error(`local provider emitted ${String(session.speakerBytes)} speaker bytes`);
    }
    if (summary.assistantTranscript !== LOCAL_FAKE_ANSWER_TRANSCRIPT) {
      throw new Error(`local transcript mismatch: ${JSON.stringify(summary.assistantTranscript)}`);
    }
    if (summary.spkFramesLost !== 0 || summary.appendErrors !== 0 || summary.invalidEvents !== 0) {
      throw new Error(
        `local stream was not lossless: ${String(summary.spkFramesLost)} lost, ` +
          `${String(summary.appendErrors)} append errors, ` +
          `${String(summary.invalidEvents)} invalid events`,
      );
    }

    const proof = {
      noCloudProvider: true,
      provider: {
        boundTo: fake.url,
        received: session.received,
        micBytes: session.micBytes,
        speakerBytes: session.speakerBytes,
        answers: session.answers,
      },
      projectId: health.projectId,
      xaiSecretUsed: false,
      voiceAgentCommit: install.commitOid,
      summary,
    };
    if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(proof, null, 2)}\n`);
    console.log(JSON.stringify(proof, null, 2));
    return proof;
  } finally {
    await fake.close();
  }
}
