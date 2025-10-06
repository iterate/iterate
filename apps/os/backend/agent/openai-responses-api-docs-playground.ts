/**************************************************************************************************
 *  OPENAI RESPONSES API – PRACTICAL OVERVIEW  (concise engineering primer)
 *
 *  NOTE: This is a playground file for exploring OpenAI's Responses API types.
 *  You'll need to install: `pnpm add openai ts-essentials`
 *  The imports are intentionally left for hover exploration.
 *
 *  ──  TL;DR  ────────────────────────────────────────────────────────────────────────────────────
 *  1.  You send *input items*  ➜  `POST /v1/responses` (or `.stream()` variant).
 *  2.  The server returns *output items*  (complete array ↔ non-streaming; chunks ↔ streaming).
 *  3.  Every output item can be echoed back later as an input item – that is how you maintain
 *      conversation state across turns.
 *  4.  A "message" is a special (deeper) structure: it's an input/output item whose `content`
 *      is itself an array of *content items* (text, image, file, …). Think slack thread.
 *
 *  Key docs:
 *    • REST reference: https://platform.openai.com/docs/api-reference/responses
 *    • Streaming format: https://platform.openai.com/docs/api-reference/responses/streaming
 **************************************************************************************************/

/* -------------------------------------------------------------------------------------------------
   IMPORT THE ACTUAL TYPES – you already have them in node_modules when using the official SDK.
   (Path may differ if package versions change.)
------------------------------------------------------------------------------------------------- */
import type {
  ResponseCreateParams, // payload you POST
  Response, // full result (non-streaming)
  ResponseStreamEvent, // SSE events
  ResponseOutputItem, // indiv. output element
  ResponseInputItem, // indiv. input element
} from "openai/resources/responses/responses.mjs";
import { OpenAI } from "openai";

import type { Prettify } from "ts-essentials";
import { logger } from "../tag-logger.ts";

// Create prettified type aliases for better hover experience
export type ResponseCreateParamsPretty = Prettify<ResponseCreateParams>;
export type ResponsePretty = Prettify<Response>;
export type ResponseStreamEventPretty = Prettify<ResponseStreamEvent>;
export type ResponseOutputItemPretty = Prettify<ResponseOutputItem>;
export type ResponseInputItemPretty = Prettify<ResponseInputItem>;

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   1.  STREAMING RESPONSES
   ------------------------------------------------------------------------------------------------
   • Call `client.responses.create({ ..., stream: true })`
   • Server emits a **Server-Sent Events** stream (`Content-Type: text/event-stream`)
   • Each event is typed as `ResponseStreamEvent` (union of ~60 variants, see SDK types)
   • Events of interest while stitching the final answer:
         - `response.output_item.added`
         - `response.output_item.done`
         - `response.completed` / `response.failed` / …
   • The *union* contains both low-level deltas (token chunks) and high-level milestones.
   • When `response.completed` arrives you have seen every output item at least once in a
     `.done`, and the stream closes.
------------------------------------------------------------------------------------------------- */

/* Example: minimal pseudo-consumer */
async function _consumeStream() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const stream = await client.responses.create({
    input: "hello",
    stream: true,
    reasoning: { effort: "low" },
  });
  const outputItems: ResponseOutputItem[] = [];

  for await (const ev of stream) {
    if (ev.type === "response.output_item.done") {
      outputItems[ev.output_index] = ev.item; // collect finalized item
    }
    if (ev.type === "response.completed") {
      logger.log("All items final:", outputItems);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   2.  OUTPUT ITEMS
   ------------------------------------------------------------------------------------------------
   Definition: `ResponseOutputItem` (union)
      • assistant message (`type:"message"`)
      • tool calls (`function_call`, `file_search_call`, `mcp_call`, …)
      • code interpreter calls, computer use, image generation, … (built-ins)
   Important rules:
      • Array order is model-chosen.
      • An output item can *immediately* be turned into an input item for the next request.
        (That's what you do to preserve history.)
------------------------------------------------------------------------------------------------- */

/* Quick sample */
const _sampleOutput: ResponseOutputItem = {
  type: "message",
  id: "msg_123",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Hello!", annotations: [] }],
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   3.  INPUT ITEMS
   ------------------------------------------------------------------------------------------------
   Definition: `ResponseInputItem` (union) – superset that ALSO includes the items we create.
      • `message` authored by user|system|developer
      • function_call_output, computer_call_output, …
   Life cycle:
      • On turn N you POST an array of input items ➜ OpenAI ➜ outputs turn N.
      • You merge your own new context + all *relevant* output items from turn N
        to build input for turn N+1.
------------------------------------------------------------------------------------------------- */

/* Turn N+1 built from previous assistant response + new user message */
const _nextTurnInput: ResponseInputItem[] = [
  // 1) echo previous assistant message (as ResponseOutputMessage)
  {
    type: "message",
    id: "msg_prev",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Hello!", annotations: [] }],
  },

  // 2) new user message
  { type: "message", role: "user", content: [{ type: "input_text", text: "How are you?" }] },
];

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   4.  "MESSAGE" ITEM STRUCTURE
   ------------------------------------------------------------------------------------------------
   A message is itself a container:
       Message
         ↳ content: ContentItem[]
   ContentItem (aka `ResponseInputContent` / subset of `ResponseOutputText`) can be:
       • input_text / output_text   – plain text
       • input_image                – image with {image_url|file_id, detail}
       • input_file                 – arbitrary file blob or file_id
   So hierarchy =  Input|Output Item  →  Message  →  Content Items.
------------------------------------------------------------------------------------------------- */

/* Example with mixed content */
const _richUserMessage: ResponseInputItem = {
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: "Summarise this PDF please:" },

    { type: "input_file", file_id: "file_abc123" },

    {
      type: "input_file",
      file_url: "https://platform.estate.iterate.com/api/files/download/123",
      file_id: "our_iterate_file_id",
    },

    { type: "input_image", image_url: "https://example.com/chart.png", detail: "auto" },
    { type: "input_image", file_id: "file_abc123", detail: "auto" },
    { type: "input_text", text: "Please summarise the PDF and the image." },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   ADVANCED EXAMPLES: Mixed Content Types
   ------------------------------------------------------------------------------------------------
   Messages can contain rich combinations of text, images, and files. Here are practical examples:
------------------------------------------------------------------------------------------------- */

/* Example 1: Analyzing multiple documents with context */
const _documentAnalysisRequest: ResponseInputItem = {
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: "Compare these financial reports and highlight key differences:" },
    { type: "input_file", file_id: "file_q1_report_2024" },
    { type: "input_file", file_id: "file_q1_report_2023" },
    { type: "input_text", text: "Pay special attention to revenue growth and operational costs." },
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KG...", detail: "high" }, // Revenue chart
  ],
};

/* Example 2: Assistant response with multiple content types and annotations */
const _assistantAnalysisResponse: ResponseOutputItem = {
  type: "message",
  id: "msg_analysis_123",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "Based on my analysis of the financial reports:",
      annotations: [],
    },
    {
      type: "output_text",
      text: "Revenue increased by 23% year-over-year, primarily driven by...",
      annotations: [
        {
          type: "file_citation",
          file_id: "file_q1_report_2024",
          filename: "Q1_2024_Financial_Report.pdf",
          index: 0,
        },
      ],
    },
  ],
};

/* Example 3: Complex user request with inline data and references */
const _dataProcessingRequest: ResponseInputItem = {
  type: "message",
  role: "user",
  content: [
    { type: "input_text", text: "Process this CSV data and create visualizations:" },
    {
      type: "input_file",
      file_data: "name,age,score\nAlice,25,92\nBob,30,87\nCarol,28,95", // Inline CSV
      filename: "scores.csv",
    },
    { type: "input_text", text: "Use this color scheme for the charts:" },
    {
      type: "input_image",
      image_url: "https://example.com/brand-colors.png",
      detail: "low", // Low detail sufficient for color reference
    },
    { type: "input_text", text: "Output should match the style of this template:" },
    { type: "input_file", file_id: "file_template_xyz" },
  ],
};

/* Example 4: Developer instructions with user content (system context mixing) */
const _contextualRequest: ResponseInputItem[] = [
  {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text: "The user will provide images of receipts. Extract amounts and dates.",
      },
    ],
  },
  {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Here are my receipts from last month:" },
      { type: "input_image", file_id: "file_receipt_001", detail: "high" },
      { type: "input_image", file_id: "file_receipt_002", detail: "high" },
      { type: "input_image", file_id: "file_receipt_003", detail: "high" },
      { type: "input_text", text: "Please organize by date and calculate total." },
    ],
  },
];

/* Example 5: Conversation with image generation and file outputs */
const _creativeWorkflow: ResponseInputItem[] = [
  // User request
  {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Create a logo based on this sketch:" },
      { type: "input_image", image_url: "data:image/jpeg;base64,...", detail: "high" },
      { type: "input_text", text: "Use these brand guidelines:" },
      { type: "input_file", file_id: "file_brand_guide" },
    ],
  },
  // Assistant uses image generation tool (output item)
  {
    type: "image_generation_call",
    id: "img_gen_001",
    status: "completed",
    result: "data:image/png;base64,iVBORw0KG...", // Generated logo
  },
  // Assistant response with the result
  {
    type: "message",
    role: "assistant",
    status: "completed",
    id: "msg_logo_result",
    content: [
      {
        type: "output_text",
        text: "I've created a logo based on your sketch. Here's the result:",
        annotations: [],
      },
      {
        type: "output_text",
        text: "The logo incorporates the blue (#0066CC) from your brand guidelines...",
        annotations: [
          {
            type: "file_citation",
            file_id: "file_brand_guide",
            filename: "brand_guidelines.pdf",
            index: 1,
          },
        ],
      },
    ],
  },
];

/* Example 6: Error handling with mixed content */
const _errorScenario: ResponseOutputItem = {
  type: "message",
  id: "msg_error",
  role: "assistant",
  status: "completed",
  content: [
    {
      type: "output_text",
      text: "I was able to process the first document successfully:",
      annotations: [],
    },
    {
      type: "refusal",
      refusal:
        "I cannot process the second file as it appears to contain sensitive personal information that I'm not authorized to handle.",
    },
    {
      type: "output_text",
      text: "Would you like me to proceed with just the first document's analysis?",
      annotations: [],
    },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   5.  FILES
   ------------------------------------------------------------------------------------------------
   • Upload separately: `POST /v1/files` ⇒ response `{ id: "file_..." }`
   • Use the file by reference: supply `file_id` inside `input_file`, or embed in
     a vector store and let `file_search` tool retrieve chunks.
   • Vector Store:   file ➜ embeddings ➜ vector store id ➜ search via built-in tool.
------------------------------------------------------------------------------------------------- */

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   6.  IMAGES
   ------------------------------------------------------------------------------------------------
   • Similar pattern:
        - Provide `input_image` with `image_url` (fully qualified URL or data-URI) **or**
          an uploaded `file_id`.
   • `detail`: "auto" | "low" | "high" influences Vision models' behaviour / cost.
------------------------------------------------------------------------------------------------- */

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   7.  TOOL CALLING
   ------------------------------------------------------------------------------------------------
   • When the model decides to invoke a tool it emits an OUTPUT item (e.g. `function_call`).
   • For most built-in tools (web_search, file_search, image_generation, …) OpenAI
     runs the tool internally and immediately follows up with a finalised item containing
     the result.
   • For **function tools** (your local code) YOU must:
        1) detect the output item (arguments are JSON string).
        2) execute the function locally.
        3) POST another *input item* of type `function_call_output` with `call_id` +
           JSON-stringified `output`.
   • Tool registration happens per-request via the `tools` array in `ResponseCreateParams`.
   
   IMPORTANT DISTINCTION:
   • `function_call` = OUTPUT item (OpenAI → You): "Please run this function"
   • `function_call_output` = INPUT item (You → OpenAI): "Here's the result"
   
   This is why `function_call_output` appears in ResponseInputItem but NOT in ResponseOutputItem.
------------------------------------------------------------------------------------------------- */

/* Example: Function tool flow */
// Step 1: OpenAI sends this OUTPUT item
const _functionCallFromOpenAI: ResponseOutputItem = {
  type: "function_call",
  id: "fc_123",
  call_id: "call_xyz",
  name: "get_weather",
  arguments: '{"location": "San Francisco"}',
};

// Step 2: You execute locally and send this INPUT item back
const _functionResultFromYou: ResponseInputItem.FunctionCallOutput = {
  type: "function_call_output",
  call_id: "call_xyz", // Must match the call_id from step 1
  output: JSON.stringify({ temperature: 72, condition: "sunny" }),
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
   8.  QUICK START SNIPPET
   ------------------------------------------------------------------------------------------------
   const res = await client.responses.create({
     model: "gpt-5",
     input: [
       { role: "user", type: "message", content: [{ type:"input_text", text:"Hi!" }] }
     ],
     tools: [{ type: "function", name: "myCalculator", parameters:{ type: "object" } }]
   });
   logger.log(res.output); // If not streaming
------------------------------------------------------------------------------------------------- */

/*
### How to explore further
1. `open openai/resources/responses/responses.d.mts` in your editor – all referenced types are there.
2. Hover the imported names in the cheat-sheet to inspect definitions.
3. Replace the sample payloads with your own and rely on TypeScript to guide you.

---

#### Reference tree (visual aid)

```
Response (REST) / Stream
└─ output: ResponseOutputItem[]
   ├─ Message (assistant)         ← contains ContentItem[]
   │    └─ ContentItem (text|img|file)
   ├─ FunctionToolCall            ← you run locally ➜ FunctionCallOutput (input)
   ├─ FileSearchToolCall          ← built-in
   ├─ WebSearchToolCall           ← built-in
   └─ …other tool-related items…
Input (next turn) mirrors this:
└─ ResponseInputItem[]
    ├─ Message (user|system|dev)
    ├─ FunctionCallOutput
    ├─ …etc
```

That's all you need to keep the moving pieces straight – happy hacking!
*/

const _r: ResponseCreateParams = {
  tool_choice: "required",
};
