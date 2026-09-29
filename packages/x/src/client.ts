import { z } from "zod";

const XUser = z.object({ id: z.string().regex(/^\d+$/), username: z.string().min(1) });
const XPost = z.object({
  id: z.string().regex(/^\d+$/),
  text: z.string(),
  author_id: z.string().regex(/^\d+$/),
  conversation_id: z.string().optional(),
  entities: z
    .object({ mentions: z.array(z.object({ username: z.string() })).optional() })
    .optional(),
});

/** Calls travel through itx.fetch: the platform substitutes the token, refreshes it and enforces
 * its origin pin. https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code */
export class XClient {
  private readonly fetcher: (request: Request) => Promise<Response>;
  private readonly connection: string;
  private readonly origin: string;
  constructor(
    fetcher: (request: Request) => Promise<Response>,
    connection: string,
    origin = "https://api.x.com",
  ) {
    this.fetcher = fetcher;
    this.connection = connection;
    this.origin = origin;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(connection) || [".", ".."].includes(connection))
      throw new Error("Invalid X connection name");
    if (new URL(origin).origin !== origin) throw new Error("X API origin must be an origin");
  }

  async me() {
    return z.object({ data: XUser }).parse(await this.call("/2/users/me")).data;
  }

  async post(id: string) {
    return z
      .object({ data: XPost })
      .parse(
        await this.call(
          `/2/tweets/${z.string().regex(/^\d+$/).parse(id)}?tweet.fields=author_id,conversation_id,entities`,
        ),
      ).data;
  }

  async mentions(userId: string, options: { sinceId?: string; paginationToken?: string } = {}) {
    const params = new URLSearchParams({
      "tweet.fields": "author_id,conversation_id,entities",
      max_results: "100",
    });
    if (options.sinceId) params.set("since_id", z.string().regex(/^\d+$/).parse(options.sinceId));
    if (options.paginationToken) params.set("pagination_token", options.paginationToken);
    return z
      .object({
        data: z.array(XPost).default([]),
        meta: z
          .object({ next_token: z.string().optional(), newest_id: z.string().optional() })
          .optional(),
      })
      .parse(
        await this.call(`/2/users/${z.string().regex(/^\d+$/).parse(userId)}/mentions?${params}`),
      );
  }

  async bookmarks(userId: string, paginationToken?: string) {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "author_id,conversation_id,entities",
    });
    if (paginationToken) params.set("pagination_token", paginationToken);
    return z
      .object({
        data: z.array(XPost).default([]),
        meta: z.object({ next_token: z.string().optional() }).optional(),
      })
      .parse(
        await this.call(`/2/users/${z.string().regex(/^\d+$/).parse(userId)}/bookmarks?${params}`),
      );
  }

  /** One attempt only: a lost POST response is ambiguous, so the caller must not retry blindly. */
  async reply(postId: string, text: string) {
    return z.object({ data: z.object({ id: z.string().regex(/^\d+$/), text: z.string() }) }).parse(
      await this.call("/2/tweets", {
        method: "POST",
        body: JSON.stringify({
          text: z.string().min(1).parse(text),
          reply: { in_reply_to_tweet_id: z.string().regex(/^\d+$/).parse(postId) },
        }),
      }),
    ).data;
  }

  private async call(path: string, init?: RequestInit) {
    const response = await this.fetcher(
      new Request(`${this.origin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer getSecret("/secrets/x-${this.connection}", { field: "accessToken" })`,
          "content-type": "application/json",
        },
        redirect: "manual",
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      // Provider response bodies may echo credentials or private data; record status alone.
      throw new XHttpError(
        response.status,
        `X ${init?.method || "GET"} ${new URL(response.url || `${this.origin}${path}`).pathname} answered ${response.status}`,
      );
    }
    return response.json();
  }
}

/** A received refusal is distinct from a request whose response was lost. */
export class XHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
