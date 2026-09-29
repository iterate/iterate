// VOICE SET UP the way Kit's Prepare and the voice app set it up: through the project's OAuth
// session, a project created from the default template gets agents and voice from its config repo's
// init case, both this checkout's pkg.pr.new builds that the loader resolves through esm.sh, and
// `ensureVoiceAgent` asks for the OpenAI key, stores it, and `itx.voice.health()` answers; the
// project's own data is left as it was. A config that installs no voice is refused at once.
import type {} from "@iterate-com/voice";
import { ensureVoiceAgent } from "@iterate-com/voice/install";
import type { IterateContextApiWith } from "iterate/api";
import { expect, test } from "vitest";
import { freshCtx, openItx, publishConfig, runId } from "../../os/e2e/support/client.ts";
import { oauthSession } from "../../os/e2e/support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  registerProject,
} from "../../os/e2e/support/project-host.ts";
import { agentsWorkspaceConfig } from "./agents-workspace-config.ts";
import { publishedPackage } from "./support.ts";

// This checkout's pkg.pr.new builds, published once its commit is pushed: the PR preview's e2e.
deployedOnly(
  "a new project's config installs voice; setting it up through project OAuth stores the key once, preserves project data, and the service answers",
  { timeout: 120_000 },
  async () => {
    const version = await publishedPackage("@iterate-com/voice");
    await publishedPackage("@iterate-com/agents");
    const user = { email: `kit-install-${runId()}@example.com` };
    const projectId = await registerProject(freshDnsSafeProjectSlug("kit-voice"), user);
    const { api } = await oauthSession(projectId, user);
    const project = await api.projects.get(projectId);
    await project.kv.put("worker.js", "my existing data");
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

test("a project whose config installs no voice is refused at once, and no key is stored", async () => {
  const root = openItx(freshCtx("voice-not-installed"));
  await publishConfig(root, agentsWorkspaceConfig);
  await expect(ensureVoiceAgent(root, "a key")).rejects.toThrow(
    "This project's config repo does not install voice",
  );
  expect(await root.secrets.list()).not.toContainEqual(
    expect.objectContaining({ path: "/secrets/openai" }),
  );
});
