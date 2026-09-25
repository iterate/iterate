import { expect, test, vi } from "vitest";
import { ensureVoiceAgent } from "./install.ts";

const workerKey = `voice/${"a".repeat(64)}/worker.js`;
const bundle = {
  agentsRuntime: { "index.ts": "agents" },
  files: { [workerKey]: "worker" },
  workerKey,
  cacheKey: `voice-worker:${"a".repeat(64)}`,
};

test("a failed upload never publishes a broken voice service and retry completes", async () => {
  const root = project();
  root.kv.put.mockRejectedValueOnce(new Error("upload interrupted"));
  await expect(ensureVoiceAgent(root, async () => bundle)).rejects.toThrow("upload interrupted");
  expect(root.append).not.toHaveBeenCalled();
  expect(await ensureVoiceAgent(root, async () => bundle)).toBe("ready");
  expect(root.append).toHaveBeenCalledTimes(2);
  expect(root.processors.enable).toHaveBeenCalledWith(
    "agents",
    expect.objectContaining({ className: "AgentCollectionDurableObject" }),
  );
});

test("a broken existing voice service is reported without replacing it", async () => {
  const root = project();
  root.rewriteRules.get.mockResolvedValue({ match: "itx.voice", target: "custom", context: "/" });
  root.voice.health.mockRejectedValue(new Error("existing service unavailable"));
  const load = vi.fn();
  await expect(ensureVoiceAgent(root, load)).rejects.toThrow("existing service unavailable");
  expect(load).not.toHaveBeenCalled();
  expect(root.append).not.toHaveBeenCalled();
  expect(root.kv.put).not.toHaveBeenCalled();
});

const project = () => ({
  whoami: vi.fn().mockResolvedValue({ path: "/" }),
  processors: { enable: vi.fn().mockResolvedValue(undefined), disable: vi.fn(), list: vi.fn() },
  secrets: {
    list: vi.fn().mockResolvedValue([{ path: "/secrets/openai" }]),
    set: vi.fn(),
    delete: vi.fn(),
  },
  rewriteRules: { get: vi.fn().mockResolvedValue(null), list: vi.fn(), resolve: vi.fn() },
  kv: {
    put: vi.fn().mockResolvedValue({ ok: true }),
    get: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
  append: vi.fn().mockResolvedValue([]),
  invoke: vi.fn(),
  voice: { health: vi.fn().mockResolvedValue({ ok: true }) },
});
