import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { codemodeContract } from "@iterate-com/codemode-contract";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

describe("live codemode", () => {
  it("serves the new run page", async () => {
    const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error(
        "CODEMODE_BASE_URL is required. Example: CODEMODE_BASE_URL=https://codemode-stg.iterate.com pnpm test:e2e",
      );
    }

    const response = await fetch(`${baseUrl}/runs-v2-new`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain("Codemode");
    expect(body).toContain("Run codemode");
    expect(body).toContain("Reset starter");
  });

  it("returns a sentinel from getIterateSecret instead of the stored secret value", async () => {
    const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("CODEMODE_BASE_URL is required for codemode e2e tests.");
    }

    const client: OrpcClient = createORPCClient(
      new OpenAPILink(codemodeContract, {
        url: `${baseUrl}/api`,
      }),
    );

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

  it("bundles a package-project snippet, reads the OpenAI key from codemode secrets, and gets a model response", async () => {
    const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");
    const openAiApiKey = process.env.OPENAI_API_KEY?.trim();

    if (!baseUrl) {
      throw new Error("CODEMODE_BASE_URL is required for codemode e2e tests.");
    }

    if (!openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for the codemode OpenAI proof e2e.");
    }

    const client: OrpcClient = createORPCClient(
      new OpenAPILink(codemodeContract, {
        url: `${baseUrl}/api`,
      }),
    );

    const nonce = randomUUID().slice(0, 8);
    const secretKey = `openai.apiKey.e2e.${nonce}`;
    const expectedReply = `codemode-openai-proof-${nonce}`;
    const secret = await client.secrets.create({
      key: secretKey,
      value: openAiApiKey,
      description: "Temporary OpenAI API key for codemode package-project e2e proof",
    });

    try {
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
  const visibleValue = await getIterateSecret({ secretKey: ${JSON.stringify(secretKey)} });
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
        `getIterateSecret({ secretKey: ${JSON.stringify(secretKey)} })`,
      );
      expect(run.result).not.toContain(openAiApiKey);
      expect(result.message).toContain(expectedReply);

      const savedRun = await client.runs.find({ id: run.id });
      expect(savedRun.error).toBeNull();
      expect(savedRun.result).not.toContain(openAiApiKey);
      expect(savedRun.result).toContain(expectedReply);
    } finally {
      await client.secrets.remove({ id: secret.id });
    }
  }, 120_000);
});
