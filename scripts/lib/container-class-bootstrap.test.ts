import { describe, expect, it } from "vitest";
import { ensureContainerClasses } from "./container-class-bootstrap.ts";

describe("ensureContainerClasses", () => {
  it("does nothing when every container class already exists", async () => {
    const calls: string[] = [];
    const cf = async <T = unknown>(path: string): Promise<T> => {
      calls.push(path);
      if (path === "/workers/scripts") {
        return [{ id: "os-preview-1", migration_tag: "v3" }] as T;
      }
      if (path.startsWith("/workers/durable_objects/namespaces?")) {
        return [{ class: "Sandbox", id: "namespace-1", script: "os-preview-1" }] as T;
      }
      throw new Error(`Unexpected Cloudflare API call ${path}`);
    };

    await expect(
      ensureContainerClasses({
        ctx: { cf },
        workerName: "os-preview-1",
        containerClassNames: ["Sandbox"],
        compatibilityDate: "2026-07-29",
      }),
    ).resolves.toEqual({ action: "skipped", missing: [] });
    expect(calls).toHaveLength(2);
  });

  it("uploads one temporary migration for only the missing classes", async () => {
    let uploadedForm: FormData | undefined;
    const cf = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      if (path === "/workers/scripts") {
        return [{ id: "os-preview-1", migration_tag: "v3" }] as T;
      }
      if (path.startsWith("/workers/durable_objects/namespaces?")) {
        return [{ class: "Existing", id: "namespace-1", script: "os-preview-1" }] as T;
      }
      if (path === "/workers/scripts/os-preview-1" && init?.method === "PUT") {
        uploadedForm = init.body as FormData;
        return {} as T;
      }
      throw new Error(`Unexpected Cloudflare API call ${path}`);
    };

    await expect(
      ensureContainerClasses({
        ctx: { cf },
        workerName: "os-preview-1",
        containerClassNames: ["Sandbox", "Existing", "Typechecker"],
        compatibilityDate: "2026-07-29",
      }),
    ).resolves.toEqual({
      action: "bootstrapped",
      missing: ["Sandbox", "Typechecker"],
    });

    expect(uploadedForm).toBeDefined();
    if (!uploadedForm) throw new Error("Expected a bootstrap upload");
    const metadata = JSON.parse(String(uploadedForm.get("metadata"))) as {
      compatibility_date: string;
      containers: Array<{ class_name: string }>;
      migrations: {
        old_tag: string;
        new_tag: string;
        steps: Array<{ new_sqlite_classes: string[] }>;
      };
    };
    expect(metadata).toMatchObject({
      compatibility_date: "2026-07-29",
      containers: [{ class_name: "Sandbox" }, { class_name: "Typechecker" }],
      migrations: {
        old_tag: "v3",
        steps: [{ new_sqlite_classes: ["Sandbox", "Typechecker"] }],
      },
    });
    expect(metadata.migrations.new_tag).toMatch(/^container-bootstrap-[a-f0-9]{8}$/);
    await expect((uploadedForm.get("bootstrap.mjs") as File).text()).resolves.toContain(
      "export class Existing",
    );
  });
});
