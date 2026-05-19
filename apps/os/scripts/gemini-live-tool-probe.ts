type JsonObject = Record<string, unknown>;

type Variant = {
  name: string;
  responseModalities: string[];
  tool: JsonObject;
  extraSetup?: JsonObject;
};

export {};

const apiKey = requireEnv("APP_CONFIG_GEMINI_API_KEY", "GEMINI_API_KEY");
const model = option("--model") ?? "gemini-3.1-flash-live-preview";
const timeoutMs = Number(option("--timeout-ms") ?? "20000");
const inputPrompt =
  option("--prompt") ??
  [
    "Call the messageAgent function now.",
    "Use message: Fetch https://example.com and summarize the page title.",
    "Do not answer in natural language before the function call.",
  ].join(" ");

const variants: Variant[] = [
  {
    name: "live-docs-json-schema-audio",
    responseModalities: ["AUDIO"],
    tool: messageAgentTool({
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The request for the background agent.",
          },
        },
        required: ["message"],
      },
    }),
  },
  {
    name: "no-parameters-audio",
    responseModalities: ["AUDIO"],
    tool: messageAgentTool({}),
  },
  {
    name: "uppercase-schema-audio",
    responseModalities: ["AUDIO"],
    tool: messageAgentTool({
      parameters: {
        type: "OBJECT",
        properties: {
          message: {
            type: "STRING",
            description: "The request for the background agent.",
          },
        },
        required: ["message"],
      },
    }),
  },
  {
    name: "tool-config-any-audio",
    responseModalities: ["AUDIO"],
    tool: messageAgentTool({
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    }),
    extraSetup: {
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: ["messageAgent"],
        },
      },
    },
  },
  {
    name: "text-modality",
    responseModalities: ["TEXT"],
    tool: messageAgentTool({
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    }),
  },
];

for (const variant of variants) {
  console.log(`\n=== ${variant.name} ===`);
  try {
    const result = await runVariant(variant);
    console.log(JSON.stringify(result, null, 2));
    if (result.toolCall != null) {
      process.exitCode = 0;
      break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  }
}

async function runVariant(variant: Variant) {
  const socket = await openGeminiLiveWebSocket();
  const messages: unknown[] = [];
  let setupComplete = false;
  let toolCall: unknown = null;
  let firstServerContent: unknown = null;

  const waitForResult = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.close();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Gemini Live WebSocket errored."));
    };

    const onMessage = (event: MessageEvent) => {
      void (async () => {
        const message = JSON.parse(await messageToText(event.data)) as JsonObject;
        messages.push(message);
        console.log("recv", JSON.stringify(summarizeMessage(message)));

        if (message.setupComplete != null && !setupComplete) {
          setupComplete = true;
          socket.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: inputPrompt }] }],
                turnComplete: true,
              },
            }),
          );
        }

        if (message.toolCall != null) {
          toolCall = message.toolCall;
          socket.send(
            JSON.stringify({
              toolResponse: {
                functionResponses: [
                  {
                    id: firstFunctionCallId(message.toolCall),
                    name: "messageAgent",
                    response: {
                      ok: true,
                      message: "Probe tool response.",
                    },
                  },
                ],
              },
            }),
          );
          cleanup();
          resolve();
        }

        if (message.serverContent != null && firstServerContent == null) {
          firstServerContent = message.serverContent;
        }
      })().catch((error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    };

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });

  socket.send(JSON.stringify(setupMessage(variant)));
  await waitForResult;

  return {
    setupComplete,
    toolCall,
    firstServerContent: summarizeMessage({ serverContent: firstServerContent }).serverContent,
    messageCount: messages.length,
  };
}

async function messageToText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

async function openGeminiLiveWebSocket() {
  const url = new URL(
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  );
  url.searchParams.set("key", apiKey);
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Gemini Live WebSocket failed.")), {
      once: true,
    });
  });
  return socket;
}

function setupMessage(variant: Variant) {
  return {
    setup: {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: {
        responseModalities: variant.responseModalities,
      },
      systemInstruction: {
        parts: [
          {
            text: "You are a tool-calling probe. When asked, call messageAgent immediately.",
          },
        ],
      },
      tools: [variant.tool],
      ...variant.extraSetup,
    },
  };
}

function messageAgentTool(input: { parameters?: JsonObject }) {
  return {
    functionDeclarations: [
      {
        name: "messageAgent",
        description: "Message the background agent to perform work.",
        ...input,
      },
    ],
  };
}

function summarizeMessage(message: JsonObject) {
  const serverContent = message.serverContent as
    | {
        modelTurn?: { parts?: Array<{ text?: string; inlineData?: unknown }> };
        turnComplete?: boolean;
      }
    | undefined;
  return {
    setupComplete: message.setupComplete != null,
    toolCall: message.toolCall,
    toolCallCancellation: message.toolCallCancellation,
    serverContent:
      serverContent == null
        ? undefined
        : {
            turnComplete: serverContent.turnComplete,
            text: serverContent.modelTurn?.parts
              ?.map((part) => part.text)
              .filter((text): text is string => typeof text === "string")
              .join(""),
            inlineDataCount: serverContent.modelTurn?.parts?.filter(
              (part) => part.inlineData != null,
            ).length,
          },
    error: message.error,
    goAway: message.goAway,
  };
}

function firstFunctionCallId(toolCall: unknown) {
  const functionCalls =
    (toolCall as { functionCalls?: Array<{ id?: string }> }).functionCalls ?? [];
  return functionCalls[0]?.id;
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function requireEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is required.`);
}
