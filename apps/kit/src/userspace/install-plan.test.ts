import { describe, expect, test } from "vitest";
import {
  KIT_VOICE_INSTALLER_MARKER,
  createKitVoiceInstallPlan,
  kitVoiceRootWorkerSource,
} from "./install-plan.ts";

const appSources = {
  "apps/kit-voice/app-ref.ts": "export const ref = {};",
  "apps/kit-voice/worker.ts": "export class KitVoiceWorker {}",
};

describe("kit voice userspace installer plan", () => {
  test("preserves an existing project worker once and installs the managed dispatcher and app", () => {
    const plan = createKitVoiceInstallPlan({
      appSources,
      baseWorker: null,
      mode: "tone",
      rootWorker: "export default class ExistingProjectWorker {}",
    });

    expect(plan.repoChanges).toContainEqual({
      content: "export default class ExistingProjectWorker {}",
      path: "worker.base.ts",
    });
    expect(plan.repoChanges).toContainEqual({
      content: kitVoiceRootWorkerSource(),
      path: "worker.ts",
    });
    expect(plan.repoChanges).toEqual(
      expect.arrayContaining(
        Object.entries(appSources).map(([path, content]) => ({ content, path })),
      ),
    );
    expect(plan).toMatchObject({
      mode: "tone",
      requiresGrokSecret: false,
      secretPath: "/secrets/kit/xai-api-key",
    });
  });

  test("is rerunnable without replacing the preserved worker", () => {
    const rootWorker = kitVoiceRootWorkerSource();
    const plan = createKitVoiceInstallPlan({
      appSources,
      baseWorker: "export default class ExistingProjectWorker {}",
      mode: "grok",
      rootWorker,
    });

    expect(plan.repoChanges).not.toContainEqual(
      expect.objectContaining({ path: "worker.base.ts" }),
    );
    expect(plan.repoChanges).not.toContainEqual(expect.objectContaining({ path: "worker.ts" }));
    expect(plan).toMatchObject({ mode: "grok", requiresGrokSecret: true });
  });

  test("refuses ambiguous existing wrapper or backup state rather than overwriting user code", () => {
    expect(() =>
      createKitVoiceInstallPlan({
        appSources,
        baseWorker: "export default class UnrelatedBackup {}",
        mode: "tone",
        rootWorker: "export default class ExistingProjectWorker {}",
      }),
    ).toThrow(/worker\.base\.ts already exists/);

    expect(() =>
      createKitVoiceInstallPlan({
        appSources,
        baseWorker: "export default class ExistingProjectWorker {}",
        mode: "tone",
        rootWorker: `${KIT_VOICE_INSTALLER_MARKER}\n// locally edited`,
      }),
    ).toThrow(/managed worker\.ts was edited/);
  });
});
