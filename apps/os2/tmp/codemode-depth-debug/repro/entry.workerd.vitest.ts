import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

type Env = {
  RECURSOR: DurableObjectNamespace<RecursorDurableObject>;
};

type EntrypointProps = {
  source: string;
};

type Hop = {
  index: number;
  kind: "route" | "entrypoint" | "durable-object" | "leaf";
  source: string;
  remaining: number;
};

type RecurseInput = {
  hops: Hop[];
  remaining: number;
};

type RecurseResult =
  | {
      ok: true;
      hops: Hop[];
    }
  | {
      ok: false;
      hops: Hop[];
      error: ErrorSummary;
    };

type ErrorSummary = {
  name: string;
  message: string;
  stackFirstLine?: string;
};

type PublicResult = {
  request: {
    path: string;
    requestedRemaining?: number;
    headers: Record<string, string>;
  };
  response: RecurseResult;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/shallow") {
      const entrypoint = ctx.exports.RecurserEntrypoint({
        props: { source: "route-shallow" } satisfies EntrypointProps,
      });
      const response = await entrypoint.shallow({
        hops: [createHop("route", "fetch", 0, 0)],
        remaining: 0,
      });

      return jsonResponse({
        request: {
          path: url.pathname,
          headers: headersToRecord(request.headers),
        },
        response,
      } satisfies PublicResult);
    }

    if (url.pathname === "/recurse") {
      const requestedRemaining = Number(url.searchParams.get("remaining") ?? "1");
      const entrypoint = ctx.exports.RecurserEntrypoint({
        props: { source: "route-recurse" } satisfies EntrypointProps,
      });

      const response = await capturePlatformError(async () => {
        return await entrypoint.recurse({
          hops: [createHop("route", "fetch", requestedRemaining, 0)],
          remaining: requestedRemaining,
        });
      });

      return jsonResponse({
        request: {
          path: url.pathname,
          requestedRemaining,
          headers: headersToRecord(request.headers),
        },
        response,
      } satisfies PublicResult);
    }

    return new Response("codemode depth debug repro", {
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  },
};

export class RecurserEntrypoint extends WorkerEntrypoint<Env, EntrypointProps> {
  async leaf(input: RecurseInput): Promise<RecurseResult> {
    return {
      ok: true,
      hops: [
        ...input.hops,
        createHop("leaf", this.ctx.props.source, input.remaining, input.hops.length),
      ],
    };
  }

  async shallow(input: RecurseInput): Promise<RecurseResult> {
    const hops = [
      ...input.hops,
      createHop("entrypoint", this.ctx.props.source, input.remaining, input.hops.length),
    ];
    const durableObject = this.env.RECURSOR.getByName("shallow");

    return await durableObject.shallow({ hops, remaining: input.remaining });
  }

  async recurse(input: RecurseInput): Promise<RecurseResult> {
    const hops = [
      ...input.hops,
      createHop("entrypoint", this.ctx.props.source, input.remaining, input.hops.length),
    ];
    const durableObject = this.env.RECURSOR.getByName("recursive-chain");

    return await durableObject.recurse({ hops, remaining: input.remaining });
  }
}

export class RecursorDurableObject extends DurableObject<Env> {
  async shallow(input: RecurseInput): Promise<RecurseResult> {
    const hops = [
      ...input.hops,
      createHop("durable-object", "do-shallow", input.remaining, input.hops.length),
    ];
    const entrypoint = this.ctx.exports.RecurserEntrypoint({
      props: { source: "do-shallow" } satisfies EntrypointProps,
    });

    return await entrypoint.leaf({ hops, remaining: input.remaining });
  }

  async recurse(input: RecurseInput): Promise<RecurseResult> {
    const hops = [
      ...input.hops,
      createHop("durable-object", "do-recursive-chain", input.remaining, input.hops.length),
    ];

    if (input.remaining <= 0) {
      return { ok: true, hops };
    }

    const entrypoint = this.ctx.exports.RecurserEntrypoint({
      props: { source: "do-recursive-chain" } satisfies EntrypointProps,
    });

    return await entrypoint.recurse({
      hops,
      remaining: input.remaining - 1,
    });
  }
}

function createHop(kind: Hop["kind"], source: string, remaining: number, index: number): Hop {
  return { index, kind, source, remaining };
}

async function capturePlatformError(
  operation: () => Promise<RecurseResult>,
): Promise<RecurseResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      ok: false,
      hops: [],
      error: summarizeError(error),
    };
  }
}

function summarizeError(error: unknown): ErrorSummary {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stackFirstLine: error.stack?.split("\n")[0],
    };
  }

  return {
    name: typeof error,
    message: String(error),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function jsonResponse(body: PublicResult) {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "x-repro-result": body.response.ok ? "ok" : "error",
    },
  });
}
