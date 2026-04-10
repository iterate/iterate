import {
  type CodemodeInput,
  CodemodeInput as CodemodeInputSchema,
} from "@iterate-com/codemode-contract";

export const CODEMODE_OPENAI_PACKAGE_PROJECT_INPUT = CodemodeInputSchema.parse({
  type: "package-project",
  entryPoint: "src/index.ts",
  files: {
    "package.json": JSON.stringify(
      {
        name: "codemode-openai-demo",
        private: true,
        type: "module",
        dependencies: {
          openai: "^6.0.0",
        },
      },
      null,
      2,
    ),
    "src/index.ts": `import OpenAI from "openai";

export default async function ({ getIterateSecret }) {
  const client = new OpenAI({
    apiKey: await getIterateSecret({ secretKey: "openai.apiKey" }),
  });

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: "Reply with the single word ready.",
  });

  return {
    modelReply: response.output_text ?? null,
  };
}
`,
  },
}) as Extract<CodemodeInput, { type: "package-project" }>;
