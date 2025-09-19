// @ts-nocheck
import { randomUUID } from "node:crypto";
import type { AgentCoreEventInput } from "@iterate-com/helpers/agent/agent-core-schemas";
import { env } from "../legacy-agent/env.ts";
import { serverTrpc } from "../legacy-agent/trpc/trpc.ts";

type UrlType = "slack" | "webpage" | "file";

interface UrlTypeInfo {
  type: UrlType;
  contentType?: string;
  slackMatch?: RegExpMatchArray;
}

function extractDetailsFromSlackLink(url: string) {
  const url = new URL(input.link);
  const [_whateverThisIs, _andThisToo, channelId, pts] = url.pathname.split("/");
  const ts = pts.slice(1);
  const threadTs = url.searchParams.get("thread_ts");

  return { ts: `${ts.slice(0, -6)}.${ts.slice(-6)}`, channelId, threadTs };
}

async function determineUrlType(url: string, headResponse?: Response): Promise<UrlTypeInfo> {
  const slackLinkMatch = url.match(/slack\.com\/archives\/([^/]+)\/p(\d+)/);
  if (slackLinkMatch) {
    return { type: "slack", slackMatch: slackLinkMatch };
  }
  let contentType = "";
  if (headResponse) {
    contentType = headResponse.headers.get("content-type") || "";
  } else {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "iterate-bot", // Otherwise we are recognized as a browser agent
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

async function handleSlackUrl(params: { url: string; db: DB }) {
  try {
    const { threadTs, channelId } = extractDetailsFromSlackLink(params.url);
    const history = await params.db
      .select()
      .from(slackWebhookEvent)
      .where(
        and(
          or(eq(slackWebhookEvent.thread_ts, threadTs), eq(slackWebhookEvent.ts, threadTs)),
          eq(slackWebhookEvent.type, "message"),
        ),
      )
      .orderBy(asc(slackWebhookEvent.ts));
    const formattedMessages = history.flatMap((h) => {
      if ("text" in h.data) {
        return [
          {
            user: h.data.user,
            text: h.data.text,
            ts: h.ts,
          },
        ];
      }
      return [];
    });
    return {
      success: true,
      contentType: "slack_thread" as const,
      textContent: formattedMessages,
      threadTs,
      messageCount: formattedMessages.length,
      slackChannelId: channelId,
    };
  } catch (error) {
    console.error("Failed to fetch Slack thread content:", error);
    return {
      success: false,
      error: `Failed to fetch Slack thread content: ${error instanceof Error ? error.message : "Unknown error"}`,
      contentType: "slack_thread" as const,
    };
  }
}

async function handleWebpageUrl(url: string, shouldMakeScreenshot: boolean) {
  const results = await Promise.allSettled([
    serverTrpc.platform.defaultTools.exaLinkContents.mutate({
      urls: [url],
      text: true,
    }),
    shouldMakeScreenshot
      ? serverTrpc.platform.defaultTools.getScreenshotForUrl.mutate({
          url,
          viewport: { width: 1200, height: 800 },
        })
      : null,
  ]);
  const exaResult = results[0].status === "fulfilled" ? results[0].value : null;
  const screenshotResult =
    shouldMakeScreenshot && results[1]?.status === "fulfilled" ? results[1].value : null;

  const additionalEvents: AgentCoreEventInput[] = [];

  if (screenshotResult?.content?.[0]?.type === "image" && screenshotResult.content[0].data) {
    // Convert base64 screenshot to bytes and upload to our system
    const base64Data = screenshotResult.content[0].data;
    const screenshotBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    const screenshotFilename = `screenshot-${randomUUID()}.png`;

    const screenshotFileRecord = await env.PLATFORM.uploadFile({
      stream: screenshotBytes,
      filename: screenshotFilename,
      contentType: "image/png",
    });

    additionalEvents.push({
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-agent-to-user",
        iterateFileId: screenshotFileRecord.iterateId,
        openAIFileId: screenshotFileRecord.openAIFileId || undefined,
        mimeType: "image/png",
      },
    });
  } else if (screenshotResult?.content?.[0]?.type === "text") {
    console.error("Screenshot failed:", screenshotResult.content[0].text);
  } else if (results[1]?.status === "rejected") {
    console.error("Screenshot API call failed:", results[1].reason);
  }
  if (results[0].status === "rejected") {
    console.error("Exa link contents failed:", results[0].reason);
    return {
      success: false,
      error: `Failed to extract webpage content: ${results[0].reason instanceof Error ? results[0].reason.message : "Unknown error"}`,
      contentType: "webpage" as const,
    };
  }

  return {
    success: true,
    contentType: "webpage" as const,
    textContent: exaResult?.results?.[0]?.text || "Could not extract text content",
    title: exaResult?.results?.[0]?.title,
    screenshotTaken: shouldMakeScreenshot && screenshotResult?.content?.[0]?.type === "image",
    __addAgentCoreEvents: additionalEvents,
  };
}

async function handleFileUrl(url: string, contentType: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "iterate-bot", // Otherwise we are recognized as a browser agent
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

  const fileRecord = await env.PLATFORM.uploadFile({
    stream: bytes,
    filename,
    contentType: contentType || "application/octet-stream",
  });

  const additionalEvents: AgentCoreEventInput[] = [
    {
      type: "CORE:FILE_SHARED",
      data: {
        direction: "from-agent-to-user",
        iterateFileId: fileRecord.iterateId,
        openAIFileId: fileRecord.openAIFileId || undefined,
        mimeType: contentType || "application/octet-stream",
      },
    },
  ];

  return {
    success: true,
    contentType: "file" as const,
    filename: fileRecord.filename,
    fileSize: bytes.length,
    mimeType: contentType,
    message: `Successfully downloaded and uploaded file: ${filename}`,
    __addAgentCoreEvents: additionalEvents,
  };
}

export async function getUrlContent(options: {
  url: string;
  shouldMakeScreenshot?: boolean;
  db: DB;
}) {
  const { url, shouldMakeScreenshot = false } = options;
  const urlInfo = await determineUrlType(url);
  switch (urlInfo.type) {
    case "slack":
      return await handleSlackUrl({
        url,
        slackMatch: urlInfo.slackMatch!,
        db,
      });
    case "webpage":
      return await handleWebpageUrl(url, shouldMakeScreenshot);
    case "file":
      try {
        return await handleFileUrl(url, urlInfo.contentType || "");
      } catch (error) {
        return {
          success: false,
          error: `Failed to process file URL: ${error instanceof Error ? error.message : "Unknown error"}`,
          contentType: "file" as const,
          mimeType: urlInfo.contentType || "",
        };
      }
    default:
      return {
        success: false,
        error: `Unsupported URL type: ${urlInfo.type}`,
        contentType: "unknown" as const,
        mimeType: urlInfo.contentType || "",
      };
  }
}
