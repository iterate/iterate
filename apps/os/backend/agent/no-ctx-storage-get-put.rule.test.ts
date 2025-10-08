import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

async function runEslintOn(code: string) {
  const eslint = new ESLint({
    useFlatConfig: true,
    overrideConfigFile: "/workspace/eslint.config.js",
    fix: false,
  } as any);
  const results = await eslint.lintText(code, { filePath: "/workspace/apps/os/backend/agent/dummy.ts" });
  return results[0];
}

describe("iterate/no-ctx-storage-get-put", () => {
  it("reports this.ctx.storage.get and suggests .storage.kv.get", async () => {
    const code = `
      class X {
        async f() {
          const result = await this.ctx.storage.get("key");
          return result;
        }
      }
    `;
    const res = await runEslintOn(code);
    const messages = res.messages.filter((m) => m.ruleId?.includes("no-ctx-storage-get-put"));
    expect(messages.length).toBe(1);
    expect(messages[0].message).toContain("storage.kv");
  });

  it("reports this.ctx.storage.put and suggests .storage.kv.put", async () => {
    const code = `
      class X {
        async f() {
          await this.ctx.storage.put("key", "value");
        }
      }
    `;
    const res = await runEslintOn(code);
    const messages = res.messages.filter((m) => m.ruleId?.includes("no-ctx-storage-get-put"));
    expect(messages.length).toBe(1);
    expect(messages[0].message).toContain("storage.kv");
  });

  it("does not report when using storage.kv.get/put", async () => {
    const code = `
      class X {
        async f() {
          const result = await this.ctx.storage.kv.get("key");
          await this.ctx.storage.kv.put("key", "value");
          return result;
        }
      }
    `;
    const res = await runEslintOn(code);
    const messages = res.messages.filter((m) => m.ruleId?.includes("no-ctx-storage-get-put"));
    expect(messages.length).toBe(0);
  });
});

