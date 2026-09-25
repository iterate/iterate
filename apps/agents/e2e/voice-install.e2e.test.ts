// VOICE INSTALLED AS A PACKAGE, the way Kit's Prepare and the voice app install it: through the
// project's OAuth session, `ensureVoiceAgent` commits `agents/` and `voice/` folders that pin this
// checkout's pkg.pr.new builds of @iterate-com/agents and @iterate-com/voice and re-export them,
// installs both from those folders, and `itx.voice.health()` answers — the loader resolved the
// packages through esm.sh. The project's own data is left as it was.
import type {} from "@iterate-com/voice";
import { ensureVoiceAgent } from "@iterate-com/voice/install";
import type { IterateContextApiWith } from "iterate/api";
import { expect } from "vitest";
import { runId } from "../../os/e2e/support/client.ts";
import { oauthSession } from "../../os/e2e/support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  registerProject,
} from "../../os/e2e/support/project-host.ts";
import { publishedPackage } from "./support.ts";

deployedOnly(
  "voice installs as a package through project OAuth, preserves project data and is kept on a second install",
  { timeout: 90_000 },
  async () => {
    const user = { email: `kit-install-${runId()}@example.com` };
    const projectId = await registerProject(freshDnsSafeProjectSlug("kit-voice"), user);
    const { api } = await oauthSession(projectId, user);
    const project = await api.projects.get(projectId);
    const versions = {
      agents: await publishedPackage("@iterate-com/agents"),
      voice: await publishedPackage("@iterate-com/voice"),
    };
    await project.kv.put("worker.js", "my existing data");
    const rulesBefore = await project.rewriteRules.list();
    expect(await ensureVoiceAgent(project, versions)).toBe("needs-openai-key");
    expect(await project.rewriteRules.get("itx.voice")).toBeNull();

    expect(await ensureVoiceAgent(project, versions, "kit-install-test-placeholder")).toBe("ready");
    const installed = project as typeof project & Pick<IterateContextApiWith<"voice">, "voice">;
    expect(await installed.voice.health()).toMatchObject({ ok: true, projectId });
    const config = project.repos.get("/repos/config");
    expect(JSON.parse((await config.readFile("agents/package.json"))!)).toEqual({
      dependencies: { "@iterate-com/agents": versions.agents },
    });
    expect(JSON.parse((await config.readFile("voice/package.json"))!)).toEqual({
      dependencies: { "@iterate-com/voice": versions.voice },
    });
    expect(await project.kv.get("worker.js")).toBe("my existing data");
    for (const before of rulesBefore)
      expect(await project.rewriteRules.get(before.match)).toEqual(before);
    expect(await project.secrets.list()).toContainEqual(
      expect.objectContaining({ path: "/secrets/openai", urls: ["https://api.openai.com"] }),
    );

    // A second device: the installed service and the stored key are kept.
    const installedRule = await project.rewriteRules.get("itx.voice");
    const secretsBefore = await project.secrets.list();
    expect(await ensureVoiceAgent(project, versions, "must-not-replace-existing-key")).toBe(
      "ready",
    );
    expect(await project.rewriteRules.get("itx.voice")).toEqual(installedRule);
    expect(await project.secrets.list()).toEqual(secretsBefore);
  },
);
