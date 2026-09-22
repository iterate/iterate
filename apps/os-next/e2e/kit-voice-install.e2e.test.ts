import { expect } from "vitest";
import { buildVoiceInstall } from "../../kit/scripts/build-voice-install.ts";
import { ensureVoiceAgent } from "../../kit/src/voice/install.ts";
import { runId } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import { deployedOnly, freshDnsSafeProjectSlug, registerProject } from "./support/project-host.ts";

deployedOnly(
  "Kit installs voice through project OAuth, preserves project data and reuses the install for another device",
  async () => {
    const user = { email: `kit-install-${runId()}@example.com` };
    const projectId = await registerProject(freshDnsSafeProjectSlug("kit-voice"), user);
    const { api } = await oauthSession(projectId, user);
    const project = await api.projects.get(projectId);
    const existingWorker = 'export default {fetch() {return new Response("my existing website")}}';
    await project.kv.put("worker.js", existingWorker);
    const rulesBefore = await project.rewriteRules.list();
    const bundle = await buildVoiceInstall();
    let downloads = 0;
    const load = async () => {
      downloads++;
      return bundle;
    };
    expect(await ensureVoiceAgent(project, load)).toBe("needs-openai-key");
    expect(downloads).toBe(0);
    expect(await project.rewriteRules.get("itx.voice")).toBeNull();
    expect(await ensureVoiceAgent(project, load, "kit-install-test-placeholder")).toBe("ready");
    expect(await project.invoke(["itx", "voice", ["health"]])).toMatchObject({
      ok: true,
      projectId,
    });
    expect(await project.kv.get("worker.js")).toBe(existingWorker);
    for (const before of rulesBefore)
      expect(await project.rewriteRules.get(before.match)).toEqual(before);
    expect(await project.secrets.list()).toContainEqual(
      expect.objectContaining({ path: "/secrets/openai", urls: ["https://api.openai.com"] }),
    );
    const installedRule = await project.rewriteRules.get("itx.voice");
    const secretsBefore = await project.secrets.list();
    expect(await ensureVoiceAgent(project, load, "must-not-replace-existing-key")).toBe("ready");
    expect(downloads).toBe(1);
    expect(await project.rewriteRules.get("itx.voice")).toEqual(installedRule);
    expect(await project.secrets.list()).toEqual(secretsBefore);
    for (const [key, content] of Object.entries(bundle.files))
      expect(await project.kv.get(key)).toBe(content);
  },
);
