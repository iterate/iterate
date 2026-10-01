// Voice set up as Kit's Prepare and the voice app set it up, through project OAuth, on a project
// whose Voice preset installs this checkout's published build. Refusals are install.test's.
import type {} from "@iterate-com/voice";
import { ensureVoiceAgent } from "@iterate-com/voice/install";
import type { IterateContextApiWith } from "iterate/api";
import { expect } from "vitest";
import { runId } from "../../helpers/client.ts";
import { oauthSession } from "../../helpers/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  preset,
  registerProject,
} from "../../helpers/project-host.ts";
import { publishedPackage } from "./support.ts";

// This checkout's pkg.pr.new builds, published once its commit is pushed: the PR preview's e2e.
deployedOnly(
  "a new project's config installs voice; setting it up through project OAuth stores the key once, preserves project data, and the service answers",
  { tags: ["slow"], timeout: 120_000 },
  async () => {
    const version = await publishedPackage("@iterate-com/voice");
    const user = { email: `kit-install-${runId()}@example.com` };
    const projectId = await registerProject(
      freshDnsSafeProjectSlug("kit-voice"),
      user,
      await preset("Voice"),
    );
    const { api } = await oauthSession(projectId, user);
    const project = await api.projects.get(projectId);
    await project.kv.put("worker.js", "my existing data");
    // the project's saga seeds its config repo before it lands `created`
    await project.waitForEvent({
      type: "events.iterate.com/project/created",
      afterOffset: 0,
      timeoutMs: 60_000,
    });
    const config = project.repos.get("/repos/config");
    expect(JSON.parse((await config.readFile("package.json"))!)).toMatchObject({
      dependencies: { "@iterate-com/voice": version },
    });
    expect(await config.readFile("voice.ts")).toContain("VoiceAgentDurableObject");
    expect(await ensureVoiceAgent(project)).toBe("needs-openai-key");

    // The first load of a new build resolves it through esm.sh; every later one reads the lock.
    expect(await ensureVoiceAgent(project, "kit-install-test-placeholder")).toBe("ready");
    const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
    expect(await installed.voice.health()).toMatchObject({ ok: true, projectId });
    expect(await project.kv.get("worker.js")).toBe("my existing data");
    expect(await project.secrets.list()).toContainEqual(
      expect.objectContaining({ path: "/secrets/openai", urls: ["https://api.openai.com"] }),
    );

    // A second device: the installed service and the stored key are kept.
    const installedRule = await project.rewriteRules.get("itx.voice");
    const secretsBefore = await project.secrets.list();
    expect(await ensureVoiceAgent(project, "must-not-replace-existing-key")).toBe("ready");
    expect(await project.rewriteRules.get("itx.voice")).toEqual(installedRule);
    expect(await project.secrets.list()).toEqual(secretsBefore);
  },
);
