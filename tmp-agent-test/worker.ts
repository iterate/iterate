interface Env {
  AI: Ai;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const response = await env.AI.run(
      "@cf/moonshotai/kimi-k2.6" as never,
      {
        messages: [
          { role: "system", content: "You are a friendly assistant" },
          { role: "user", content: "What is AI Gateway? Answer in one sentence." },
        ],
      },
      { gateway: { id: "default" }, metadata: { teamId: "AI", userId: 12345 } } as never,
    );
    return Response.json(response);
  },
};
