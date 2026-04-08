import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { describe, expect, it } from "vitest";
import { codemodeContract } from "@iterate-com/codemode-contract";

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

  it("bundles a package-project snippet, reads the OpenAI key from codemode secrets, and gets a model response", async () => {
    const baseUrl = process.env.CODEMODE_BASE_URL?.trim().replace(/\/+$/, "");
    const openAiApiKey = process.env.OPENAI_API_KEY?.trim();

    if (!baseUrl) {
      throw new Error("CODEMODE_BASE_URL is required for codemode e2e tests.");
    }

    if (!openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required for the codemode OpenAI proof e2e.");
    }

    const client = createORPCClient(
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
  const client = new OpenAI({
    apiKey: await getIterateSecret({ secretKey: ${JSON.stringify(secretKey)} }),
  });

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: ${JSON.stringify(`Reply with exactly ${expectedReply} and nothing else.`)},
  });

  return {
    message: response.output_text ?? null,
  };
}
              `.trim(),
          },
        },
        sources: [],
      });

      expect(run.error).toBeNull();

      const result = JSON.parse(run.result) as { message?: string | null };
      expect(result.message).toContain(expectedReply);

      const savedRun = await client.runs.find({ id: run.id });
      expect(savedRun.error).toBeNull();
      expect(savedRun.result).toContain(expectedReply);
    } finally {
      await client.secrets.remove({ id: secret.id });
    }
  }, 120_000);
});
