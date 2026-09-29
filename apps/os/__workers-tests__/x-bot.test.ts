import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { installAgents } from "../../../packages/agents/src/install.ts";
import { installXBot } from "../../../packages/x/src/install.ts";
import { agentsWorkspaceSource } from "../../agents/e2e/agents-source.ts";
import { followConsent, ORIGIN, petshopFakes, projectWithMember } from "./support.ts";

const xSource: Record<string, string> = {
  "package.json": '{"main":"bot.ts"}',
  ...Object.fromEntries(
    Object.entries(
      import.meta.glob<string>("../../../packages/x/src/{bot,client}.ts", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
  ),
};

test.for([
  { name: "sent", outcome: "sent", botId: "100" },
  { name: "missing posting permission", outcome: "missing-scope", botId: "100" },
  { name: "retry a failed draft", outcome: "draft-retry", botId: "100" },
  { name: "correct a rejected reply", outcome: "rejected", botId: "100" },
  { name: "unknown", outcome: "unknown", botId: "101" },
  { name: "revoked", outcome: "revoked", botId: "100" },
])(
  "a userspace bot verifies and drafts once: $name on explicit send",
  async ({ outcome, botId }) => {
    const member = await projectWithMember(`x-bot-${outcome}`);
    const petshop = petshopFakes();
    const botConsent = await member.itx.integrations.connect("x", {
      connection: "bot",
      scopes: outcome === "missing-scope" ? [] : ["tweet.write"],
      next: `${ORIGIN}/done`,
    });
    expect(
      await followConsent(
        petshop,
        `${botConsent.authorizationUrl}&user=${botId}&username=iteratebot`,
        member.cookie,
      ),
    ).toMatchObject({ status: 303 });
    const personal = await member.session.user.integrations.connect("x", {
      connection: "sender",
      next: `${ORIGIN}/done`,
    });
    expect(
      await followConsent(
        petshop,
        `${personal.authorizationUrl}&user=12345&username=jonas`,
        member.cookie,
      ),
    ).toMatchObject({ status: 303 });
    await member.itx.integrations.connect("x", { account: "@jonas" });
    if (outcome !== "draft-retry") await installAgents(member.itx, agentsWorkspaceSource);
    await installXBot(member.itx, xSource, { botConnection: "bot", apiOrigin: "https://x.test" });
    const model = new DraftModel();
    const attempt = outcome === "draft-retry" ? 2 : 1;
    const agent = member.itx.cd(`/agents/x/${botId}/111/${attempt}`);
    await agent.provide("itx.ai", model);
    await agent.append({
      type: "events.iterate.com/agent/configured",
      payload: { config: { llm: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" } } },
    });
    const prepare = (postId: string) =>
      member.itx.invoke([
        "itx",
        "facets",
        ["get", "x-bot"],
        ["prepare", { postId, senderConnection: "sender" }],
      ]);
    const sent = () =>
      petshop.requests.filter(
        (request) => request.method === "POST" && request.url.endsWith("/2/tweets"),
      );
    await expect(prepare("112")).rejects.toThrow("not written by the verified");
    expect(model).toMatchObject({ calls: 0 });
    if (outcome === "draft-retry") {
      await expect(prepare("111")).rejects.toThrow();
      expect(
        await member.itx.invoke(["itx", "facets", ["get", "x-bot"], ["receipt", "111"]]),
      ).toMatchObject({ status: "failed", attempt: 1 });
      await installAgents(member.itx, agentsWorkspaceSource);
    }
    const draft = await prepare("111");
    expect(draft).toMatchObject({
      status: "draft",
      senderId: "12345",
      botId,
      draft: "Hello from Iterate!",
      attempt,
    });
    const readsBeforeRepeat = petshop.requests.length;
    expect(await prepare("111")).toEqual(draft);
    expect(petshop.requests).toHaveLength(readsBeforeRepeat);
    expect(model).toMatchObject({ calls: 1 });
    expect(sent()).toHaveLength(0);
    await expect(agent.cd("sandbox").invoke(["itx", "agents", ["list"]])).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
    });
    await expect(
      agent.cd("sandbox").invoke(["itx", "kv", ["get", "private"]]),
    ).rejects.toMatchObject({ code: "NO_ITX_EXPRESSION_MATCH" });
    await expect(
      agent
        .cd("sandbox")
        .run(
          `await fetch("https://x.test/2/tweets", { method: "POST", headers: { authorization: 'Bearer getSecret("/secrets/x-bot", { field: "accessToken" })' }, body: JSON.stringify({text: "unreviewed"}) });`,
        ),
    ).rejects.toThrow();
    expect(sent()).toHaveLength(0);
    const send = (text = "Hello, reviewed!") =>
      member.itx.invoke(["itx", "facets", ["get", "x-bot"], ["send", { postId: "111", text }]]);
    if (outcome === "rejected") {
      await expect(send("reject this fixture")).rejects.toThrow("400");
      expect(
        await member.itx.invoke(["itx", "facets", ["get", "x-bot"], ["receipt", "111"]]),
      ).toMatchObject({ status: "draft", failureCode: "X_HTTP_400" });
    }
    if (outcome === "missing-scope") {
      await expect(send()).rejects.toThrow("Reconnect the bot with tweet.write");
      expect(
        await member.itx.invoke(["itx", "facets", ["get", "x-bot"], ["receipt", "111"]]),
      ).toMatchObject({ status: "draft" });
      expect(sent()).toHaveLength(0);
      return;
    }
    if (outcome === "revoked") {
      await member.session.user.integrations.disconnect("x", "sender");
      await expect(send()).rejects.toThrow("binding changed");
      expect(sent()).toHaveLength(0);
      return;
    }
    if (outcome === "unknown") {
      await expect(send()).rejects.toThrow("503");
      expect(
        await member.itx.invoke(["itx", "facets", ["get", "x-bot"], ["receipt", "111"]]),
      ).toMatchObject({ status: "unknown" });
    } else
      expect(await send()).toMatchObject({
        status: "sent",
        replyId: "99999",
        draft: "Hello from Iterate!",
        sentText: "Hello, reviewed!",
      });
    await expect(send()).rejects.toThrow("no unsent draft");
    expect(sent()).toHaveLength(outcome === "rejected" ? 2 : 1);
    expect(JSON.parse(sent().at(-1)!.body)).toEqual({
      text: "Hello, reviewed!",
      reply: { in_reply_to_tweet_id: "111" },
    });
  },
);

class DraftModel extends RpcTarget {
  calls = 0;
  run() {
    this.calls += 1;
    return { response: "Hello from Iterate!" };
  }
}
