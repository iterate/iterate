import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { codemodeContract } from "@iterate-com/codemode-contract";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;
const defaultOpenAiSecretKey = "openai.apiKey";

function requireCodemodeBaseUrl() {
  const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");

  if (!baseUrl) {
    throw new Error("CODEMODE_BASE_URL is required for codemode e2e tests.");
  }

  return baseUrl;
}

function requireOpenAiApiKey() {
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();

  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required for the codemode OpenAI e2e proofs.");
  }

  return openAiApiKey;
}

async function createClient(baseUrl: string) {
  return createORPCClient(
    new OpenAPILink(codemodeContract, {
      url: `${baseUrl}/api`,
    }),
  ) as OrpcClient;
}

async function ensureOpenAiSecret(client: OrpcClient) {
  const openAiApiKey = requireOpenAiApiKey();
  const existingSecrets = await client.secrets.list({ limit: 100, offset: 0 });
  const existing = existingSecrets.secrets.find((secret) => secret.key === defaultOpenAiSecretKey);

  if (existing) {
    await client.secrets.remove({ id: existing.id });
  }

  return client.secrets.create({
    key: defaultOpenAiSecretKey,
    value: openAiApiKey,
    description: "Shared OpenAI API key for codemode live e2e and preview proofs",
  });
}

describe("live codemode", () => {
  it("serves the new run page", async () => {
    const baseUrl = requireCodemodeBaseUrl();

    const response = await fetch(`${baseUrl}/runs-v2-new`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("Codemode");
    expect(body).toContain("Run codemode");
    expect(body).toContain("Reset starter");
  });

  it("returns a sentinel from getIterateSecret instead of the stored secret value", async () => {
    const baseUrl = requireCodemodeBaseUrl();
    const client = await createClient(baseUrl);

    const nonce = randomUUID().slice(0, 8);
    const secretKey = `openai.apiKey.e2e.${nonce}`;
    const actualSecretValue = `sk-live-proof-${nonce}`;
    const expectedSentinel = `getIterateSecret({ secretKey: ${JSON.stringify(secretKey)} })`;
    const secret = await client.secrets.create({
      key: secretKey,
      value: actualSecretValue,
      description: "Temporary secret for codemode sentinel visibility proof",
    });

    try {
      const foundSecret = await client.secrets.find({ id: secret.id });
      expect(foundSecret.key).toBe(secretKey);
      expect(JSON.stringify(foundSecret)).not.toContain(actualSecretValue);
      expect("value" in (foundSecret as object)).toBe(false);

      const run = await client.runV2({
        input: {
          type: "package-project",
          entryPoint: "src/index.ts",
          files: {
            "package.json": JSON.stringify(
              {
                name: "codemode-secret-sentinel-proof",
                private: true,
                type: "module",
              },
              null,
              2,
            ),
            "src/index.ts": `
export default async function ({ getIterateSecret }) {
  return {
    visibleValue: await getIterateSecret({ secretKey: ${JSON.stringify(secretKey)} }),
  };
}
              `.trim(),
          },
        },
        sources: [],
      });

      expect(run.error).toBeNull();

      const result = JSON.parse(run.result) as { visibleValue?: string | null };
      expect(result.visibleValue).toBe(expectedSentinel);
      expect(run.result).not.toContain(actualSecretValue);
    } finally {
      await client.secrets.remove({ id: secret.id });
    }
  });

  it("ignores a user-supplied executor.js module and still runs the generated executor", async () => {
    const baseUrl = requireCodemodeBaseUrl();
    const client = await createClient(baseUrl);

    const run = await client.runV2({
      input: {
        type: "package-project",
        entryPoint: "src/index.ts",
        files: {
          "package.json": JSON.stringify(
            {
              name: "codemode-executor-collision-proof",
              private: true,
              type: "module",
            },
            null,
            2,
          ),
          "executor.js": `
export default {
  async evaluate() {
    return {
      result: "user executor should never run",
    };
  },
};
          `.trim(),
          "src/index.ts": `
export default async function () {
  return {
    message: "generated executor still won",
  };
}
          `.trim(),
        },
      },
      sources: [],
    });

    expect(run.error).toBeNull();
    expect(run.result).toContain("generated executor still won");
    expect(run.result).not.toContain("user executor should never run");
  });

  it("runs a package project whose entry point bundles to executor.js without self-importing", async () => {
    const baseUrl = requireCodemodeBaseUrl();
    const client = await createClient(baseUrl);

    const run = await client.runV2({
      input: {
        type: "package-project",
        entryPoint: "executor.ts",
        files: {
          "package.json": JSON.stringify(
            {
              name: "codemode-entrypoint-executor-proof",
              private: true,
              type: "module",
            },
            null,
            2,
          ),
          "executor.ts": `
export default async function () {
  return {
    message: "executor entrypoint ran",
  };
}
          `.trim(),
        },
      },
      sources: [],
    });

    expect(run.error).toBeNull();
    expect(run.result).toContain("executor entrypoint ran");
  });

  it("bundles a package-project snippet, reads the OpenAI key from codemode secrets, and gets a model response", async () => {
    const baseUrl = requireCodemodeBaseUrl();
    const openAiApiKey = requireOpenAiApiKey();
    const client = await createClient(baseUrl);

    await ensureOpenAiSecret(client);

    const nonce = randomUUID().slice(0, 8);
    const expectedReply = `codemode-openai-proof-${nonce}`;
    const run = await client.runV2({
      input: {
        type: "package-project",
        entryPoint: "src/index.ts",
        files: {
          "package.json": JSON.stringify(
            {
              name: "codemode-openai-proof",
              private: true,
              type: "module",
              dependencies: {
                openai: "^6.0.0",
              },
            },
            null,
            2,
          ),
          "src/index.ts": `
import OpenAI from "openai";

export default async function ({ getIterateSecret }) {
  const visibleValue = await getIterateSecret({ secretKey: ${JSON.stringify(defaultOpenAiSecretKey)} });
  const client = new OpenAI({
    apiKey: visibleValue,
  });

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: ${JSON.stringify(`Reply with exactly ${expectedReply} and nothing else.`)},
  });

  return {
    visibleValue,
    message: response.output_text ?? null,
  };
}
          `.trim(),
        },
      },
      sources: [],
    });

    expect(run.error).toBeNull();

    const result = JSON.parse(run.result) as {
      message?: string | null;
      visibleValue?: string | null;
    };
    expect(result.visibleValue).toBe(
      `getIterateSecret({ secretKey: ${JSON.stringify(defaultOpenAiSecretKey)} })`,
    );
    expect(run.result).not.toContain(openAiApiKey);
    expect(result.message).toContain(expectedReply);

    const savedRun = await client.runs.find({ id: run.id });
    expect(savedRun.error).toBeNull();
    expect(savedRun.result).not.toContain(openAiApiKey);
    expect(savedRun.result).toContain(expectedReply);
  }, 120_000);
});
