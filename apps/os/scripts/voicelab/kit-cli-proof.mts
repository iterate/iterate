// Phase 5 exit proof: the TypeScript voice CLI holds a conversation against
// the local dev server, provider-hermetic (loopback fake Grok, no xAI).
import process from "node:process";
import { connectItxReady } from "iterate/node";
import { installVoiceAgent } from "./deploy.ts";
import { LOCAL_FAKE_ANSWER_TRANSCRIPT, startLocalFakeGrok } from "./local-fake-grok.ts";
import { voiceCli } from "../../../kit/clients/voice-cli.ts";

const baseUrl = process.env.PROOF_BASE_URL ?? "http://localhost:49770";
const project = process.env.PROOF_PROJECT ?? "kit-voice-proof";
const adminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!adminSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET missing");

// 1. Ensure the project exists and carries the current voice agent.
{
  using os = await connectItxReady({
    auth: { type: "admin-secret", secret: adminSecret },
    baseUrl,
  });
  using handle = os.projects.get(project);
  await handle.create({}, { waitUntilCreated: true });
  console.error(`proof: project ${project} ready`);
}
{
  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret: adminSecret },
    baseUrl,
    projectId: project,
  });
  const install = await installVoiceAgent(itx);
  console.error(`proof: voice agent installed at ${install.commitOid}`);
}

// 2. Loopback provider + the CLI under test.
const fake = await startLocalFakeGrok();
try {
  const summary = await voiceCli({
    baseUrl,
    project,
    adminSecret,
    grokBaseUrl: fake.url,
    turns: 1,
    out: process.env.PROOF_OUT,
  });
  const session = fake.sessions.at(-1);
  if (!session) throw new Error("the worker never dialled the local provider");
  if (session.micBytes === 0) throw new Error("no microphone bytes reached the provider");
  if (summary.assistantTranscript !== LOCAL_FAKE_ANSWER_TRANSCRIPT) {
    throw new Error(`transcript mismatch: ${JSON.stringify(summary.assistantTranscript)}`);
  }
  if (summary.identity.gaps !== 0 || summary.appendErrors !== 0 || summary.invalidEvents !== 0) {
    throw new Error(
      `not lossless: gaps=${summary.identity.gaps} appendErrors=${summary.appendErrors} invalid=${summary.invalidEvents}`,
    );
  }
  console.error("proof: PASS — hermetic conversation held by the kit voice CLI");
} finally {
  await fake.close();
}
