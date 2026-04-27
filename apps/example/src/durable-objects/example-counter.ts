import { DurableObject } from "cloudflare:workers";

type CounterState = {
  count: number;
  updatedAt: string | null;
};

const counterKey = "counter";

export class ExampleCounter extends DurableObject<Env> {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/durable-counter") {
      return Response.json(await this.readState());
    }

    if (request.method === "POST" && url.pathname === "/api/durable-counter/increment") {
      return Response.json(await this.increment());
    }

    if (request.method === "POST" && url.pathname === "/api/durable-counter/reset") {
      return Response.json(await this.reset());
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async readState(): Promise<CounterState> {
    return (
      (await this.ctx.storage.get<CounterState>(counterKey)) ?? {
        count: 0,
        updatedAt: null,
      }
    );
  }

  private async increment() {
    const current = await this.readState();
    const next = {
      count: current.count + 1,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(counterKey, next);
    return next;
  }

  private async reset() {
    const next = {
      count: 0,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(counterKey, next);
    return next;
  }
}

export default {
  fetch() {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler;
