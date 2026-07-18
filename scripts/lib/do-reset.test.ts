import { describe, expect, test, vi } from "vitest";
import { detachExternalDurableObjectBindings, resetWorkerDurableObjects } from "./do-reset.ts";

type Settings = {
  annotations?: Record<string, unknown>;
  bindings: Record<string, unknown>[];
};

async function readSettingsPatch(init: RequestInit | undefined) {
  expect(init?.method).toBe("PATCH");
  expect(init?.body).toBeInstanceOf(FormData);
  if (!(init?.body instanceof FormData)) throw new Error("expected a FormData settings patch");
  const part = init.body.get("settings");
  expect(part).toBeInstanceOf(Blob);
  expect((part as Blob).type).toBe("application/json");
  return JSON.parse(await (part as Blob).text()) as Settings;
}

describe("detachExternalDurableObjectBindings", () => {
  test("removes only target references and inherits every opaque survivor", async () => {
    const settings = new Map<string, Settings>([
      [
        "sidecar",
        {
          annotations: {
            "workers/message": "sidecar release",
            "workers/tag": "commit-123",
            "workers/triggered_by": "version_upload",
          },
          bindings: [
            {
              class_name: "CapabilityHost",
              name: "CAPABILITY_HOST",
              namespace_id: "target-capability-host",
              script_name: "os-preview-4",
              type: "durable_object_namespace",
            },
            {
              class_name: "Project",
              name: "PROJECT",
              namespace_id: "target-project",
              script_name: "old-worker-name",
              type: "durable_object_namespace",
            },
            {
              class_name: "Loader",
              name: "LOADER",
              namespace_id: "sidecar-loader",
              script_name: "sidecar",
              type: "durable_object_namespace",
            },
            { name: "REDACTED_SECRET", type: "secret_text" },
          ],
        },
      ],
      ["unrelated", { bindings: [{ name: "KV", namespace_id: "kv-id", type: "kv_namespace" }] }],
    ]);
    const cf = vi.fn(async (path: string, init?: RequestInit) => {
      const workerName = path.split("/").at(-2) as string;
      const current = settings.get(workerName);
      if (!current) throw new Error(`unexpected settings request for ${workerName}`);
      if (!init) return structuredClone(current);

      const patch = await readSettingsPatch(init);
      settings.set(workerName, {
        annotations: patch.annotations,
        bindings: patch.bindings.map((binding) => {
          expect(binding.type).toBe("inherit");
          return structuredClone(
            current.bindings.find((candidate) => candidate.name === binding.name) as Record<
              string,
              unknown
            >,
          );
        }),
      });
      return settings.get(workerName);
    });

    await expect(
      detachExternalDurableObjectBindings({
        ctx: { cf } as never,
        targetWorkerName: "os-preview-4",
        targetNamespaceIds: ["target-capability-host", "target-project"],
        workerNames: ["os-preview-4", "sidecar", "unrelated"],
      }),
    ).resolves.toEqual([
      {
        workerName: "sidecar",
        removedBindingNames: ["CAPABILITY_HOST", "PROJECT"],
      },
    ]);

    expect(settings.get("sidecar")).toEqual({
      annotations: {
        "workers/message": "sidecar release",
        "workers/tag": "commit-123",
      },
      bindings: [
        {
          class_name: "Loader",
          name: "LOADER",
          namespace_id: "sidecar-loader",
          script_name: "sidecar",
          type: "durable_object_namespace",
        },
        { name: "REDACTED_SECRET", type: "secret_text" },
      ],
    });
    expect(cf.mock.calls.some(([path]) => path.includes("os-preview-4/settings"))).toBe(false);
    expect(cf.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  test("fails before reset can continue when Cloudflare keeps a target reference", async () => {
    const stale: Settings = {
      bindings: [
        {
          name: "PROJECT",
          namespace_id: "target-project",
          script_name: "os-preview-4",
          type: "durable_object_namespace",
        },
      ],
    };
    const cf = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init) await readSettingsPatch(init);
      return structuredClone(stale);
    });

    await expect(
      detachExternalDurableObjectBindings({
        ctx: { cf } as never,
        targetWorkerName: "os-preview-4",
        targetNamespaceIds: ["target-project"],
        workerNames: ["os-preview-4", "sidecar"],
      }),
    ).rejects.toThrow("settings readback did not preserve");
  });
});

describe("resetWorkerDurableObjects", () => {
  test("deletes a retired container application before tombstoning its class", async () => {
    const applications = [
      {
        id: "sandbox-app",
        name: "os-preview-4-SandboxBasicDurableObject",
        durable_objects: { namespace_id: "sandbox-namespace" },
      },
      {
        id: "retired-builder-app",
        name: "os-preview-4-WorkerBuilderDurableObject",
        durable_objects: { namespace_id: "retired-builder-namespace" },
      },
    ];
    let deployedMetadata: Record<string, unknown> | undefined;
    const cf = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/workers/scripts") return [{ id: "os-preview-4" }];
      if (path.startsWith("/workers/durable_objects/namespaces?")) {
        return [
          {
            id: "sandbox-namespace",
            script: "os-preview-4",
            class: "SandboxBasicDurableObject",
          },
          {
            id: "retired-builder-namespace",
            script: "os-preview-4",
            class: "WorkerBuilderDurableObject",
          },
        ];
      }
      if (path === "/containers/applications") return structuredClone(applications);
      if (path === "/containers/applications/retired-builder-app") {
        expect(init?.method).toBe("DELETE");
        applications.splice(
          applications.findIndex((application) => application.id === "retired-builder-app"),
          1,
        );
        return undefined;
      }
      if (path === "/workers/scripts/os-preview-4") {
        expect(init?.method).toBe("PUT");
        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        if (!(body instanceof FormData)) throw new Error("expected a FormData worker upload");
        const metadata = body.get("metadata");
        expect(typeof metadata).toBe("string");
        deployedMetadata = JSON.parse(metadata as string) as Record<string, unknown>;
        return undefined;
      }
      throw new Error(`unexpected Cloudflare request: ${path}`);
    });

    await expect(
      resetWorkerDurableObjects({
        ctx: { cf } as never,
        workerName: "os-preview-4",
        cwd: "/tmp/os",
        credentials: {},
        compatibilityDate: "2026-07-01",
        containerClassNames: ["SandboxBasicDurableObject"],
      }),
    ).resolves.toEqual({
      action: "reset",
      deletedClasses: ["WorkerBuilderDurableObject"],
      keptContainerClasses: ["SandboxBasicDurableObject"],
    });

    expect(deployedMetadata).toMatchObject({
      containers: [{ class_name: "SandboxBasicDurableObject" }],
      migrations: { steps: [{ deleted_classes: ["WorkerBuilderDurableObject"] }] },
    });
    expect(applications).toEqual([
      {
        id: "sandbox-app",
        name: "os-preview-4-SandboxBasicDurableObject",
        durable_objects: { namespace_id: "sandbox-namespace" },
      },
    ]);
  });
});
