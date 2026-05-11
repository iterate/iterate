import type { Entry as HarEntry } from "har-format";
import { describe, expect, test } from "vitest";
import type { HarEntryWithExtensions } from "./har-extensions.ts";
import {
  createDefaultHarSanitizer,
  formatSanitizedSecret,
  isIterateSecretPlaceholder,
  isRedactedSecret,
} from "./har-sanitizer.ts";

function httpEntry(opts: {
  requestHeaders?: Array<{ name: string; value: string }>;
  responseHeaders?: Array<{ name: string; value: string }>;
  queryString?: Array<{ name: string; value: string }>;
  url?: string;
  method?: string;
  requestBodySize?: number;
  postData?: { mimeType: string; text: string };
  responseContent?: { size: number; mimeType: string; text?: string };
  responseBodySize?: number;
  _iterateMetadata?: HarEntryWithExtensions["_iterateMetadata"];
}): HarEntry {
  const entry: HarEntryWithExtensions = {
    startedDateTime: "2026-03-03T10:00:00.000Z",
    time: 50,
    request: {
      method: opts.method ?? "GET",
      url: opts.url ?? "https://api.test/v1",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: opts.requestHeaders ?? [],
      queryString: opts.queryString ?? [],
      headersSize: -1,
      bodySize: opts.requestBodySize ?? (opts.postData ? opts.postData.text.length : 0),
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: opts.responseHeaders ?? [{ name: "content-type", value: "application/json" }],
      content: opts.responseContent ?? { size: 0, mimeType: "application/octet-stream" },
      redirectURL: "",
      headersSize: -1,
      bodySize: opts.responseBodySize ?? opts.responseContent?.size ?? 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
  if (opts._iterateMetadata) entry._iterateMetadata = opts._iterateMetadata;
  return entry as HarEntry;
}

function wsEntry(overrides: {
  requestHeaders?: Array<{ name: string; value: string }>;
  messages?: Array<{ type: "send" | "receive"; time: number; opcode: number; data: string }>;
}): HarEntryWithExtensions {
  return {
    startedDateTime: "2026-03-03T10:00:00.000Z",
    time: 100,
    request: {
      method: "GET",
      url: "wss://api.test/socket",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: overrides.requestHeaders ?? [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 101,
      statusText: "Switching Protocols",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: "x-application/websocket" },
      redirectURL: "",
      headersSize: -1,
      bodySize: 0,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: "websocket",
    _webSocketMessages: overrides.messages ?? [],
  };
}

describe("formatSanitizedSecret", () => {
  test.for([
    ["openai-style key", "sk-proj-abc123xyz", "sk-pr---sanitised-secret-0f959513"],
    ["slack bot token", "xoxb-1234-abcdef", "xoxb---sanitised-secret-44fd94b9"],
    ["github pat", "ghp_abcdefghijklmnop", "ghp_ab---sanitised-secret-7ddfcc93"],
    ["very short secret", "ab", "---sanitised-secret-fb8e20fc"],
    ["empty string", "", "---sanitised-secret-e3b0c442"],
  ] as const)("%s", ([_desc, input, expected]) => {
    expect(formatSanitizedSecret(input)).toBe(expected);
  });
});

describe("isIterateSecretPlaceholder", () => {
  test.for([
    ["double-quoted secretKey", 'getIterateSecret({secretKey: "openai_api_key"})', true],
    ["single-quoted secretKey", "getIterateSecret({secretKey: 'github.access_token'})", true],
    ["bearer token", "Bearer sk-real-key-123", false],
    ["plain string", "just a normal string", false],
  ] as const)("%s", ([_desc, input, expected]) => {
    expect(isIterateSecretPlaceholder(input)).toBe(expected);
  });
});

describe("isRedactedSecret", () => {
  test("round-trip verification", () => {
    const original = "sk-proj-abc123xyz";
    const redacted = formatSanitizedSecret(original);
    expect(isRedactedSecret(redacted, original)).toBe(true);
    expect(isRedactedSecret(redacted, "different-secret")).toBe(false);
  });
});

describe("createDefaultHarSanitizer", () => {
  const sanitize = createDefaultHarSanitizer();

  const sanitizerCases: Array<[string, HarEntry, HarEntry]> = [
    [
      "Bearer auth header — preserves scheme, redacts credential",
      httpEntry({
        requestHeaders: [
          { name: "authorization", value: "Bearer sk-proj-abc123xyz" },
          { name: "accept", value: "application/json" },
        ],
      }),
      httpEntry({
        requestHeaders: [
          { name: "authorization", value: "Bearer sk-pr---sanitised-secret-0f959513" },
          { name: "accept", value: "application/json" },
        ],
        _iterateMetadata: { sanitizedHeaders: ["authorization"] },
      }),
    ],

    [
      "set-cookie — preserves cookie name, redacts value",
      httpEntry({
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "set-cookie", value: "session=secret123" },
        ],
      }),
      httpEntry({
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "set-cookie", value: "session=se---sanitised-secret-fcf730b6" },
        ],
        _iterateMetadata: { sanitizedHeaders: ["set-cookie"] },
      }),
    ],

    [
      "set-cookie — preserves attributes (Path, HttpOnly)",
      httpEntry({
        responseHeaders: [{ name: "set-cookie", value: "session=secret123; Path=/; HttpOnly" }],
      }),
      httpEntry({
        responseHeaders: [
          { name: "set-cookie", value: "session=se---sanitised-secret-fcf730b6; Path=/; HttpOnly" },
        ],
        _iterateMetadata: { sanitizedHeaders: ["set-cookie"] },
      }),
    ],

    [
      "cookie header — multiple cookies, each value redacted independently",
      httpEntry({
        requestHeaders: [{ name: "cookie", value: "session=abc; tracker=xyz123" }],
      }),
      httpEntry({
        requestHeaders: [
          {
            name: "cookie",
            value: "session=---sanitised-secret-ba7816bf; tracker=x---sanitised-secret-f0a72890",
          },
        ],
        _iterateMetadata: { sanitizedHeaders: ["cookie"] },
      }),
    ],

    [
      "getIterateSecret header preserved",
      httpEntry({
        requestHeaders: [
          {
            name: "authorization",
            value: 'Bearer getIterateSecret({secretKey: "openai_api_key"})',
          },
        ],
      }),
      httpEntry({
        requestHeaders: [
          {
            name: "authorization",
            value: 'Bearer getIterateSecret({secretKey: "openai_api_key"})',
          },
        ],
      }),
    ],

    [
      "x-api-key header redacted",
      httpEntry({
        requestHeaders: [{ name: "x-api-key", value: "my-api-key-123" }],
      }),
      httpEntry({
        requestHeaders: [{ name: "x-api-key", value: "my-a---sanitised-secret-3eeee459" }],
        _iterateMetadata: { sanitizedHeaders: ["x-api-key"] },
      }),
    ],

    [
      "x-*-key wildcard header redacted",
      httpEntry({
        requestHeaders: [{ name: "x-custom-key", value: "custom_key_789" }],
      }),
      httpEntry({
        requestHeaders: [{ name: "x-custom-key", value: "cust---sanitised-secret-ea72f247" }],
        _iterateMetadata: { sanitizedHeaders: ["x-custom-key"] },
      }),
    ],

    [
      "x-*-token wildcard header redacted",
      httpEntry({
        requestHeaders: [{ name: "x-csrf-token", value: "csrf_token_abc" }],
      }),
      httpEntry({
        requestHeaders: [{ name: "x-csrf-token", value: "csrf---sanitised-secret-c352809d" }],
        _iterateMetadata: { sanitizedHeaders: ["x-csrf-token"] },
      }),
    ],

    [
      "api-key header redacted",
      httpEntry({
        requestHeaders: [{ name: "api-key", value: "my-api-key-123" }],
      }),
      httpEntry({
        requestHeaders: [{ name: "api-key", value: "my-a---sanitised-secret-3eeee459" }],
        _iterateMetadata: { sanitizedHeaders: ["api-key"] },
      }),
    ],

    [
      "query param token redacted",
      httpEntry({
        url: "https://api.test/v1?token=rawsecret&page=1",
        queryString: [
          { name: "token", value: "rawsecret" },
          { name: "page", value: "1" },
        ],
      }),
      httpEntry({
        url: "https://api.test/v1?token=rawsecret&page=1",
        queryString: [
          { name: "token", value: "ra---sanitised-secret-efa00f2b" },
          { name: "page", value: "1" },
        ],
      }),
    ],

    [
      "OAuth query params redacted",
      httpEntry({
        url: "https://api.test/oauth?client_id=client-id-foo&client_secret=oauth_client_secret&code=oauth-auth-code&oauth_token=oauth_token_abc&sig=sig-value-123&state=state-xyz",
        queryString: [
          { name: "client_id", value: "client-id-foo" },
          { name: "client_secret", value: "oauth_client_secret" },
          { name: "code", value: "oauth-auth-code" },
          { name: "oauth_token", value: "oauth_token_abc" },
          { name: "sig", value: "sig-value-123" },
          { name: "state", value: "state-xyz" },
        ],
      }),
      httpEntry({
        url: "https://api.test/oauth?client_id=client-id-foo&client_secret=oauth_client_secret&code=oauth-auth-code&oauth_token=oauth_token_abc&sig=sig-value-123&state=state-xyz",
        queryString: [
          { name: "client_id", value: "cli---sanitised-secret-1e5f6b88" },
          { name: "client_secret", value: "oauth---sanitised-secret-20673dcc" },
          { name: "code", value: "oaut---sanitised-secret-328b5b8b" },
          { name: "oauth_token", value: "oaut---sanitised-secret-cac20fd2" },
          { name: "sig", value: "sig---sanitised-secret-e61b0d64" },
          { name: "state", value: "st---sanitised-secret-7dd6ddbb" },
        ],
      }),
    ],

    [
      "JSON request body key redacted — bodySize updated",
      httpEntry({
        method: "POST",
        postData: {
          mimeType: "application/json",
          text: '{"apiKey":"my-secret-value","model":"gpt-4"}',
        },
      }),
      httpEntry({
        method: "POST",
        requestBodySize: 44,
        postData: {
          mimeType: "application/json",
          text: '{"apiKey":"my-s---sanitised-secret-be22cbae","model":"gpt-4"}',
        },
      }),
    ],

    [
      "OAuth JSON request body keys redacted",
      httpEntry({
        method: "POST",
        postData: {
          mimeType: "application/json",
          text: '{"client_id":"client-id-foo","client_secret":"oauth_client_secret","code":"oauth-auth-code","state":"state-xyz"}',
        },
      }),
      httpEntry({
        method: "POST",
        requestBodySize: 112,
        postData: {
          mimeType: "application/json",
          text: '{"client_id":"cli---sanitised-secret-1e5f6b88","client_secret":"oauth---sanitised-secret-20673dcc","code":"oaut---sanitised-secret-328b5b8b","state":"st---sanitised-secret-7dd6ddbb"}',
        },
      }),
    ],

    [
      "JSON response body — content.size, bodySize, content-length updated + original-content-length header",
      httpEntry({
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "content-length", value: "38" },
        ],
        responseContent: {
          size: 38,
          mimeType: "application/json",
          text: '{"access_token":"rawsecret","ok":true}',
        },
        responseBodySize: 38,
      }),
      httpEntry({
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "content-length", value: "59" },
          { name: "x-iterate-har-original-content-length", value: "38" },
        ],
        responseContent: {
          size: 59,
          mimeType: "application/json",
          text: '{"access_token":"ra---sanitised-secret-efa00f2b","ok":true}',
        },
        responseBodySize: 59,
      }),
    ],

    [
      "response body without content-length header — no content-length added, original-length still added",
      httpEntry({
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        responseContent: {
          size: 38,
          mimeType: "application/json",
          text: '{"access_token":"rawsecret","ok":true}',
        },
        responseBodySize: 38,
      }),
      httpEntry({
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "x-iterate-har-original-content-length", value: "38" },
        ],
        responseContent: {
          size: 59,
          mimeType: "application/json",
          text: '{"access_token":"ra---sanitised-secret-efa00f2b","ok":true}',
        },
        responseBodySize: 59,
      }),
    ],

    [
      "non-JSON body pass-through",
      httpEntry({
        method: "POST",
        postData: { mimeType: "text/plain", text: "plain text body" },
      }),
      httpEntry({
        method: "POST",
        requestBodySize: 15,
        postData: { mimeType: "text/plain", text: "plain text body" },
      }),
    ],

    [
      "Discord identify (op:2 d.token)",
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"op":2,"d":{"token":"discord-bot-token","properties":{"os":"linux"}}}',
          },
        ],
      }) as HarEntry,
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"op":2,"d":{"token":"disco---sanitised-secret-60e3d0b3","properties":{"os":"linux"}}}',
          },
        ],
      }) as HarEntry,
    ],

    [
      "GraphQL connection_init auth",
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"type":"connection_init","payload":{"authorization":"Bearer gql-secret"}}',
          },
        ],
      }) as HarEntry,
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"type":"connection_init","payload":{"authorization":"Beare---sanitised-secret-4d74bf4b"}}',
          },
        ],
      }) as HarEntry,
    ],

    [
      "Coinbase subscribe jwt",
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"type":"subscribe","channel":"user","jwt":"eyJ.coinbase.secret"}',
          },
        ],
      }) as HarEntry,
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"type":"subscribe","channel":"user","jwt":"eyJ.c---sanitised-secret-cea864d6"}',
          },
        ],
      }) as HarEntry,
    ],

    [
      "WS getIterateSecret carve-out",
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"op":2,"d":{"token":"getIterateSecret({secretKey: \'bot_token\'})"}}',
          },
        ],
      }) as HarEntry,
      wsEntry({
        messages: [
          {
            type: "send",
            time: 1000,
            opcode: 1,
            data: '{"op":2,"d":{"token":"getIterateSecret({secretKey: \'bot_token\'})"}}',
          },
        ],
      }) as HarEntry,
    ],

    [
      "WS binary frame untouched",
      wsEntry({
        messages: [{ type: "receive", time: 1000, opcode: 2, data: "base64binarydata" }],
      }) as HarEntry,
      wsEntry({
        messages: [{ type: "receive", time: 1000, opcode: 2, data: "base64binarydata" }],
      }) as HarEntry,
    ],

    [
      "no sensitive fields — no response text means no size changes",
      httpEntry({
        url: "https://example.com/",
        requestHeaders: [
          { name: "accept", value: "*/*" },
          { name: "host", value: "example.com" },
        ],
      }),
      httpEntry({
        url: "https://example.com/",
        requestHeaders: [
          { name: "accept", value: "*/*" },
          { name: "host", value: "example.com" },
        ],
      }),
    ],
  ];

  test.for(sanitizerCases)("%s", ([_desc, input, expected]) => {
    expect(sanitize(structuredClone(input))).toEqual(expected);
  });
});
