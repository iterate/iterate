import { randomUUID } from "node:crypto";
import { z } from "zod";
import { or, eq, asc } from "drizzle-orm";
import { env } from "../env.ts";
import type { AgentCoreEvent } from "./agent/agent-core-schemas.ts";
import type { DB } from "./db/client.ts";
import { slackWebhookEvent } from "./db/schema.ts";
import { uploadFile } from "./file-handlers.ts";
import { logger } from "./tag-logger.ts";

const ContentsOptions = z.object({
  text: z
    .union([
      z.boolean().describe("Enable full text extraction (true) or disable (false)"),
      z.object({
        maxCharacters: z
          .number()
          .describe("Maximum character limit for the full page text")
          .optional(),
        includeHtmlTags: z
          .boolean()
          .describe("Include HTML tags in the response for structure understanding")
          .optional(),
      }),
    ])
    .describe(
      "Text extraction options - boolean for simple extraction or object for advanced control",
    )
    .optional(),
  highlights: z
    .object({
      numSentences: z
        .number()
        .default(5)
        .describe("Number of sentences to return for each highlight snippet"),
      highlightsPerURL: z
        .number()
        .default(1)
        .describe("Number of highlight snippets to return for each result"),
      query: z
        .string()
        .describe("Custom query to direct the LLM's selection of highlights")
        .optional(),
    })
    .describe("Text snippets that the LLM identifies as most relevant from each page")
    .optional(),
  summary: z
    .object({
      query: z.string().describe("Custom query for the LLM-generated summary"),
      schema: z
        .record(z.string(), z.any())
        .describe("JSON schema for structured output from summary")
        .optional(),
    })
    .describe("Generate a summary of the webpage content")
    .optional(),
  livecrawl: z
    .enum(["never", "fallback", "always", "preferred"])
    .describe(
      "Options for livecrawling pages: 'never' (use cache only), 'fallback' (try cache first), 'always' (force fresh crawl), 'preferred' (prefer fresh but accept cache)",
    )
    .optional(),
  livecrawlTimeout: z.number().default(10000).describe("Timeout for livecrawling in milliseconds"),
  subpages: z.number().default(0).describe("Number of subpages to crawl from each result"),
  subpageTarget: z
    .union([z.string(), z.array(z.string())])
    .describe(
      "Keyword(s) to find specific subpages of search results. Keep null if you don't want subpages.",
    )
    .optional(),
});

const ContentsRequest = ContentsOptions;

const Result = z.object({
  title: z.string(),
  url: z.string().url(),
  publishedDate: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  id: z.string(),
  image: z.string().optional(),
  favicon: z.string().url().optional(),
});

const ResultWithContent: z.ZodType<any> = Result.extend({
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  highlightScores: z.array(z.number()).optional(),
  summary: z.string().optional(),
  subpages: z.array(z.lazy(() => ResultWithContent)).optional(),
  extras: z
    .object({
      links: z.array(z.string()).optional(),
    })
    .optional(),
});

const CostDollars = z.object({
  total: z.number().optional(),
  breakDown: z
    .array(
      z.object({
        search: z.number().optional(),
        contents: z.number().optional(),
        breakdown: z
          .object({
            keywordSearch: z.number().optional(),
            neuralSearch: z.number().optional(),
            contentText: z.number().optional(),
            contentHighlight: z.number().optional(),
            contentSummary: z.number().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  perRequestPrices: z
    .object({
      neuralSearch_1_25_results: z.number().optional(),
      neuralSearch_26_100_results: z.number().optional(),
      neuralSearch_100_plus_results: z.number().optional(),
      keywordSearch_1_100_results: z.number().optional(),
      keywordSearch_100_plus_results: z.number().optional(),
    })
    .optional(),
  perPagePrices: z
    .object({
      contentText: z.number().optional(),
      contentHighlight: z.number().optional(),
      contentSummary: z.number().optional(),
    })
    .optional(),
});

// Search endpoint schemas
export const SearchRequest = z.object({
  query: z.string().describe("The search query string for finding relevant web content"),
  type: z
    .enum(["keyword", "neural", "fast", "auto"])
    .default("auto")
    .describe(
      "Search type: 'keyword' (traditional search), 'neural' (embeddings-based), 'fast' (streamlined versions), 'auto' (intelligent combination)",
    ),
  category: z
    .enum([
      "company",
      "research paper",
      "news",
      "pdf",
      "github",
      "tweet",
      "personal site",
      "linkedin profile",
      "financial report",
    ])
    .describe("Focus on a specific data category if the user is explicitly asking for it")
    .optional(),
  numResults: z
    .number()
    .max(100)
    .default(50)
    .describe("Number of search results to return (recommened minimum 50, maximum 100)"),
  includeDomains: z
    .array(z.string())
    .describe(
      "Only return results from these specific domains if the user is explicitly asking for it",
    )
    .optional(),
  excludeDomains: z
    .array(z.string())
    .describe("Exclude results from these domains if the user is explicitly asking for it")
    .optional(),
  includeText: z
    .array(z.string())
    .describe("Results must contain these strings in the page text (max 1 string, up to 5 words)")
    .optional(),
  excludeText: z
    .array(z.string())
    .describe(
      "Results must NOT contain these strings in the page text (max 1 string, up to 5 words)",
    )
    .optional(),
});

const SearchResponse = z.object({
  requestId: z.string(),
  resolvedSearchType: z.string().optional(), // Make this more flexible
  results: z.array(ResultWithContent),
  searchType: z.string().optional(), // Make this more flexible instead of enum
  context: z.string().optional(),
  costDollars: CostDollars.partial().optional(), // Make costDollars optional and partial
});

// Contents endpoint schemas
const ContentsRequestInput = z
  .object({
    urls: z.array(z.string().url()).describe("Array of URLs to extract content from"),
    ids: z
      .array(z.string())
      .describe("Deprecated - use 'urls' instead. Array of document IDs from previous searches")
      .optional(),
  })
  .merge(ContentsOptions);

const ContentsResponse = z.object({
  requestId: z.string(),
  results: z.array(ResultWithContent),
  context: z.string().optional(),
  statuses: z
    .array(
      z.object({
        id: z.string(),
        status: z.string(), // Make status more flexible
        error: z
          .object({
            tag: z.string().optional(), // Make tag more flexible
            httpStatusCode: z.number().nullable().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  costDollars: CostDollars.optional(), // Make costDollars optional
});

// FindSimilar endpoint schemas
const FindSimilarRequest = z.object({
  url: z.string().url().describe("The URL for which you want to find similar content"),
  numResults: z
    .number()
    .max(100)
    .default(10)
    .describe("Number of similar results to return (maximum 100)"),
  includeDomains: z
    .array(z.string())
    .describe("Only return results from these specific domains")
    .optional(),
  excludeDomains: z.array(z.string()).describe("Exclude results from these domains").optional(),
  includeText: z
    .array(z.string())
    .describe("Results must contain these strings in the page text (max 1 string, up to 5 words)")
    .optional(),
  excludeText: z
    .array(z.string())
    .describe(
      "Results must NOT contain these strings in the page text (max 1 string, up to 5 words)",
    )
    .optional(),
  context: z
    .union([
      z.boolean().describe("Enable context formatting for LLM consumption"),
      z.object({
        maxCharacters: z
          .number()
          .describe("Maximum character limit for the context string")
          .optional(),
      }),
    ])
    .describe("Format search results into a context string ready for LLMs")
    .optional(),
  contents: ContentsRequest.describe(
    "Additional content extraction options for the similar results",
  ).optional(),
});

const FindSimilarResponse = z.object({
  requestId: z.string(),
  context: z.string().optional(),
  results: z.array(ResultWithContent),
  costDollars: CostDollars.optional(), // Make costDollars optional
});

const EXA_BASE_URL = "https://api.exa.ai";
const PARALLEL_AI_BASE_URL = "https://api.parallel.ai/v1";
const ITERATE_USER_AGENT = "iterate-bot";

async function callExaEndpoint<Schema extends z.ZodTypeAny>(
  path: string,
  payload: unknown,
  schema: Schema,
) {
  const response = await fetch(`${EXA_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": getExaApiKey(),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Exa API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return zodParse(`${path} response`, schema, data);
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

function getExaApiKey() {
  const apiKey = env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY environment variable is not set");
  }
  return apiKey;
}

function getParallelAIApiKey() {
  const apiKey = env.PARALLEL_AI_API_KEY;
  if (!apiKey) {
    throw new Error("PARALLEL_AI_API_KEY environment variable is not set");
  }
  return apiKey;
}

function getCloudflareApiToken() {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN environment variable is not set");
  }
  return apiToken;
}

function getCloudflareAccountId() {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID environment variable is not set");
  }
  return accountId;
}

export async function findSimilarLinks(input: z.infer<typeof FindSimilarRequest>) {
  const payload = FindSimilarRequest.parse(input);
  return callExaEndpoint("/findSimilar", payload, FindSimilarResponse);
}

// Regular functions for use in iterate-agent.ts (non-TRPC versions)
export async function searchWeb(input: z.infer<typeof SearchRequest>) {
  const parsedInput = SearchRequest.parse(input);
  const payload = {
    ...parsedInput,
    // just a quick fix to make this work a lil better as per
    // https://docs.exa.ai/reference/search#body-contents-text
    // if we end up keeping it, we should refactor this exa integration to be less crufty
    contents: {
      text: true,
      context: true,
      livecrawl: "preferred",
    },
  };

  return callExaEndpoint("/search", payload, SearchResponse);
}

const zodParse = <Z extends z.ZodType<any, any, any>>(
  context: string,
  schema: Z,
  input: unknown,
) => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`${context} parse failed: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

export async function getURLContentFromExa(input: z.infer<typeof ContentsRequestInput>) {
  const payload = zodParse(JSON.stringify(input), ContentsRequestInput, input);
  return callExaEndpoint("/contents", payload, ContentsResponse);
}

export async function getScreenshotForURL(input: {
  url: string;
  viewport?: { height?: number; width?: number };
}) {
  try {
    const apiToken = getCloudflareApiToken();
    const accountId = getCloudflareAccountId();

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          url: input.url,
          viewport: input.viewport,
          // https://developers.cloudflare.com/browser-rendering/rest-api/screenshot-endpoint/#navigate-and-capture-a-full-page-screenshot
          screenshotOptions: {
            fullPage: true,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Cloudflare API error: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");

    return {
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: base64Image,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error getting screenshot: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
    };
  }
}

type UrlType = "slack" | "webpage" | "file";

interface UrlTypeInfo {
  type: UrlType;
  contentType?: string;
}

// ---------------------------------------------
// URL handler registry (easy to extend)
// ---------------------------------------------
type UrlHandler = (args: {
  url: string;
  db: DB;
  estateId: string;
  includeScreenshotOfPage?: boolean;
  includeTextContent?: boolean;
}) => Promise<unknown>;

const urlHandlers: Array<{ pattern: RegExp; handler: UrlHandler }> = [
  {
    pattern: /https?:\/\/[^\s]*slack\.com\/archives\/[^/]+\/p\d+/i,
    handler: async ({ url, db }) => getURLContentFromSlack({ url, db }),
  },
  // Add more handlers here (e.g. linear, github, etc.)
];

function extractDetailsFromSlackLink(url: string) {
  const urlObj = new URL(url);
  const [_whateverThisIs, _andThisToo, channelId, pts] = urlObj.pathname.split("/");
  const ts = pts.slice(1);
  const threadTs = urlObj.searchParams.get("thread_ts");

  return { ts: `${ts.slice(0, -6)}.${ts.slice(-6)}`, channelId, threadTs };
}

async function determineURLContentTypeFromHEAD(
  url: string,
  headResponse?: Response,
): Promise<UrlTypeInfo> {
  // Default detection path (only used if no registry handler matches)
  let contentType = "";
  if (headResponse) {
    contentType = headResponse.headers.get("content-type") || "";
  } else {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": ITERATE_USER_AGENT, // Otherwise we are recognized as a browser agent
      },
    });
    contentType = response.headers.get("content-type") || "";
  }
  const normalizedContentType = contentType.toLowerCase().split(";")[0].trim();

  const webpageContentTypes = new Set([
    "text/html",
    "application/xhtml+xml",
    "text/xml",
    "application/xml",
  ]);

  const isWebpage = webpageContentTypes.has(normalizedContentType);

  return {
    type: isWebpage ? "webpage" : "file",
    contentType,
  };
}

// gets the content of a link to another slack thread
// TODO:
// - this should use the slack api instead of slack webhooks table
// - this should format webhooks consistently with slack-slice
// - this should upload files to the iterate file system that are shared on that thread
//
async function getURLContentFromSlack(params: { url: string; db: DB }) {
  try {
    const { threadTs, channelId, ts } = extractDetailsFromSlackLink(params.url);
    const whereCondition = threadTs
      ? or(eq(slackWebhookEvent.thread_ts, threadTs), eq(slackWebhookEvent.ts, threadTs))
      : or(eq(slackWebhookEvent.ts, ts), eq(slackWebhookEvent.thread_ts, ts));

    const history = await params.db
      .select()
      .from(slackWebhookEvent)
      .where(whereCondition)
      .orderBy(asc(slackWebhookEvent.ts));
    const formattedMessages = history.flatMap((h) => h.data); // Preserve original webhook payloads
    return {
      success: true,
      contentType: "slack_thread" as const,
      textContent: formattedMessages,
      threadTs,
      messageCount: formattedMessages.length,
      slackChannelId: channelId,
    };
  } catch (error) {
    logger.error("Failed to fetch Slack thread content:", error);
    return {
      success: false,
      error: `Failed to fetch Slack thread content: ${error instanceof Error ? error.message : "Unknown error"}`,
      contentType: "slack_thread" as const,
    };
  }
}

async function getURLContentFromWebpage(params: {
  url: string;
  includeScreenshotOfPage: boolean;
  includeTextContent: boolean;
  estateId: string;
  db: DB;
}) {
  const { url, includeScreenshotOfPage, includeTextContent, estateId, db } = params;
  const [textResult, screenshotResult] = await Promise.allSettled([
    includeTextContent
      ? getURLContentFromExa({
          urls: [url],
          text: true,
          livecrawlTimeout: 10000,
          subpages: 0,
        })
      : Promise.resolve(null),
    includeScreenshotOfPage
      ? getScreenshotForURL({
          url,
          viewport: { width: 1200, height: 800 },
        })
      : Promise.resolve(null),
  ]);

  const additionalEvents: AgentCoreEvent[] = [];
  const exaResult = includeTextContent && isFulfilled(textResult) ? textResult.value : null;

  if (includeTextContent && !isFulfilled(textResult)) {
    logger.error("Exa link contents failed:", textResult.reason);
    if (!includeScreenshotOfPage || !isFulfilled(screenshotResult)) {
      return {
        success: false,
        error: `Failed to extract webpage content of ${url}: ${textResult.reason instanceof Error ? textResult.reason.message : "Unknown error"}`,
        contentType: "webpage" as const,
      };
    }
  }

  let screenshotTaken = false;
  if (includeScreenshotOfPage) {
    if (isFulfilled(screenshotResult)) {
      const screenshotPayload = screenshotResult.value?.content?.[0];

      if (
        screenshotPayload?.type === "image" &&
        "data" in screenshotPayload &&
        screenshotPayload.data
      ) {
        const screenshotBytes = Buffer.from(screenshotPayload.data, "base64");
        const screenshotFilename = `screenshot-${randomUUID()}.png`;

        const screenshotFileRecord = await uploadFile({
          stream: screenshotBytes,
          estateId,
          db,
          filename: screenshotFilename,
          contentType: "image/png",
        });

        if (!screenshotFileRecord.openAIFileId) {
          throw new Error("Screenshot file record does not have an openAIFileId");
        }

        additionalEvents.push({
          type: "CORE:FILE_SHARED",
          data: {
            direction: "from-agent-to-user",
            iterateFileId: screenshotFileRecord.id,
            openAIFileId: screenshotFileRecord.openAIFileId,
            mimeType: "image/png",
          },
        });
        screenshotTaken = true;
      } else if (screenshotPayload?.type === "text" && "text" in screenshotPayload) {
        logger.error("Screenshot failed:", screenshotPayload.text);
      }
    } else {
      logger.error("Screenshot API call failed:", screenshotResult.reason);
    }
  }

  return {
    success: true,
    contentType: "webpage" as const,
    textContent:
      exaResult?.results?.[0]?.text ||
      (includeTextContent ? "Could not extract text content" : undefined),
    title: exaResult?.results?.[0]?.title,
    screenshotTaken,
    __addAgentCoreEvents: additionalEvents.length > 0 ? additionalEvents : undefined,
  };
}

async function getURLContentFromFile(params: {
  url: string;
  contentType: string;
  estateId: string;
  db: DB;
}) {
  const { url, contentType, estateId, db } = params;
  const response = await fetch(url, {
    headers: {
      "User-Agent": ITERATE_USER_AGENT, // Otherwise we are recognized as a browser agent
    },
  });
  if (!response.ok) {
    return {
      success: false,
      error: `Failed to fetch file: ${response.status} ${response.statusText}`,
      contentType: "file" as const,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const urlParts = new URL(url);
  const filename = urlParts.pathname.split("/").pop() || `downloaded-file-${randomUUID()}`;

  const fileRecord = await uploadFile({
    stream: bytes,
    estateId: estateId,
    db: db,
    filename: filename,
    contentType: contentType || "application/octet-stream",
  });

  logger.log(`File uploaded for ${url}: ${fileRecord.id}`);

  const additionalEvents: AgentCoreEvent[] = [
    {
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-agent-to-user",
        iterateFileId: fileRecord.id,
        mimeType: contentType || "application/octet-stream",
      },
    },
  ];

  return {
    success: true,
    contentType: "file" as const,
    filename: filename,
    fileSize: bytes.length,
    mimeType: contentType,
    message: `Successfully downloaded and uploaded file: ${filename}`,
    __addAgentCoreEvents: additionalEvents,
  };
}

export async function getURLContent(options: {
  url: string;
  includeScreenshotOfPage?: boolean;
  includeTextContent?: boolean;
  db: DB;
  estateId: string;
}) {
  const { url, includeScreenshotOfPage = false, includeTextContent = true, db, estateId } = options;

  // 1) Try registry handlers first
  for (const { pattern, handler } of urlHandlers) {
    if (pattern.test(url)) {
      return handler({ url, db, estateId, includeScreenshotOfPage, includeTextContent });
    }
  }

  // 2) Default path: HEAD to decide file vs webpage
  const headResponse = await fetch(url, {
    method: "HEAD",
    headers: { "User-Agent": ITERATE_USER_AGENT },
  }).catch(() => undefined);

  const urlInfo = await determineURLContentTypeFromHEAD(url, headResponse);
  if (urlInfo.type === "webpage") {
    return await getURLContentFromWebpage({
      url,
      includeScreenshotOfPage,
      includeTextContent,
      estateId,
      db,
    });
  } else {
    return await getURLContentFromFile({
      url,
      contentType: urlInfo.contentType || "",
      estateId,
      db,
    });
  }
}

// Parallel AI Deep Research schemas
const DeepResearchInputType = z.object({
  query: z.string().max(15000),
  processor: z.enum(["pro", "ultra"]).default("pro"),
  outputFormat: z.enum(["auto", "text"]).default("text"),
});

const DeepResearchCitation = z.object({
  url: z.string(),
  excerpts: z.array(z.string()).optional(),
  title: z.string().optional(),
});

const DeepResearchFieldBasis = z.object({
  field: z.string(),
  reasoning: z.string().optional(),
  citations: z.array(DeepResearchCitation).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const DeepResearchTaskRunResponse = z.object({
  run_id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
});

const DeepResearchResultType = z.object({
  output: z.object({
    content: z.any(),
    basis: z.array(DeepResearchFieldBasis).optional(),
    run_id: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    created_at: z.string().optional(),
    completed_at: z.string().optional(),
    processor: z.string().optional(),
    warnings: z.any().optional(),
    error: z.any().optional(),
  }),
});

export type DeepResearchInputType = z.infer<typeof DeepResearchInputType>;
export type DeepResearchResultType = z.infer<typeof DeepResearchResultType>;

/**
 * Create a deep research task using Parallel AI's Task API.
 * Returns the run_id immediately - use checkDeepResearchStatus to poll for results.
 */
export async function createDeepResearchTask(input: DeepResearchInputType) {
  const parsedInput = DeepResearchInputType.parse(input);
  const apiKey = getParallelAIApiKey();

  const taskSpec =
    parsedInput.outputFormat === "text" ? { output_schema: { type: "text" as const } } : undefined;

  const createResponse = await fetch(`${PARALLEL_AI_BASE_URL}/task_run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: parsedInput.query,
      processor: parsedInput.processor,
      ...(taskSpec ? { task_spec: taskSpec } : {}),
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(
      `Parallel AI API error: ${createResponse.status} ${createResponse.statusText} - ${errorText}`,
    );
  }

  const taskRun = zodParse(
    "task_run create response",
    DeepResearchTaskRunResponse,
    await createResponse.json(),
  );

  return taskRun;
}

/**
 * Check the status of a deep research task.
 * Returns null if still processing (202 status), or the result if completed/failed.
 */
export async function checkDeepResearchStatus(runId: string) {
  const apiKey = getParallelAIApiKey();

  const resultResponse = await fetch(`${PARALLEL_AI_BASE_URL}/task_run/${runId}/result`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // 202 means still processing
  if (resultResponse.status === 202) {
    return { status: "running" as const, runId };
  }

  if (!resultResponse.ok) {
    const errorText = await resultResponse.text();
    throw new Error(
      `Parallel AI API error: ${resultResponse.status} ${resultResponse.statusText} - ${errorText}`,
    );
  }

  const result = zodParse(
    "task_run result response",
    DeepResearchResultType,
    await resultResponse.json(),
  );

  return result;
}

// Note: TRPC router removed as requested - only utility functions remain
