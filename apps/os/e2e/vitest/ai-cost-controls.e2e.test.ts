import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Opt-in vendor proof: tiny OpenAI and Workers AI calls, not a paid CI test matrix.
test.runIf(process.env.AI_COST_LIVE_PROOF === "1")(
  "company-key copies use the gateway; customer credentials keep their billing; unsupported company transports fail closed",
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(`ai-cost-proof-${crypto.randomUUID()}`).create({});
    using company = project.secrets.get("/secrets/company-proof");
    using customer = project.secrets.get("/secrets/customer-proof");
    const companyKey = process.env.APP_CONFIG_OPEN_AI_API_KEY;
    if (!companyKey) throw new Error("Live proof requires the deployment's company key");
    await company.create({ egress: { urls: ["https://api.openai.com"] }, material: companyKey });
    await customer.create({
      egress: { urls: ["https://api.openai.com"] },
      material: "sk-invalid-customer-proof",
    });
    try {
      const companyGet = await project.egress.fetch("https://api.openai.com/v1/models", {
        headers: { authorization: 'Bearer getSecret("/secrets/company-proof")' },
      });
      expect(companyGet).toMatchObject({ status: 400 });
      await expect(companyGet.json()).resolves.toMatchObject({
        error: { code: "company_ai_transport_unsupported" },
      });
      const customerGet = await project.egress.fetch("https://api.openai.com/v1/models", {
        headers: { authorization: 'Bearer getSecret("/secrets/customer-proof")' },
      });
      expect(customerGet).toMatchObject({ status: 401 });
      await expect(customerGet.json()).resolves.toMatchObject({ error: expect.any(Object) });
      const generated = await project.ai.run(
        "@cf/meta/llama-3.2-1b-instruct",
        { prompt: "Reply OK", max_tokens: 3 },
        {
          gateway: { id: "caller-must-not-select-this", metadata: { projectId: "forged" } },
        },
      );
      expect(generated).toMatchObject({ response: expect.any(String) });
      const workerStream: any = await project.ai.run(
        "@cf/meta/llama-3.2-1b-instruct",
        { prompt: "Count from one to twenty.", max_tokens: 64, stream: true },
        { returnRawResponse: true },
      );
      expect(workerStream).toMatchObject({ status: 200 });
      expect(await workerStream.text()).toContain("data: [DONE]");
      const response = await project.egress.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: 'Bearer getSecret("/secrets/company-proof")',
          "content-type": "application/json",
          "cf-aig-metadata": '{"projectId":"forged"}',
        },
        body: JSON.stringify({
          model: "gpt-4.1-nano",
          messages: [{ role: "user", content: "Count from one to twenty, one number per line." }],
          max_tokens: 64,
          stream: true,
          stream_options: { include_usage: false },
        }),
      });
      expect(response).toMatchObject({ status: 200 });
      const body = await response.text();
      expect(body).toContain('"choices":');
      expect(body).toContain("data: [DONE]");
      expect(body).toContain('"prompt_tokens":');
      const logId = response.headers.get("cf-aig-log-id");
      expect(logId).toBeTruthy();
      console.log("AI_COST_GATEWAY_PROOF", {
        project: (await project.__describe()).projectId,
        logId,
      });
    } finally {
      await company.update({ refresh: null });
      await customer.update({ refresh: null });
    }
  },
);
