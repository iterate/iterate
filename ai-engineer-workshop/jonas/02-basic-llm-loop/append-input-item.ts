/**
 * Appends one `input-item-added` event to a stream.
 *
 * Run:
 *   node 02-basic-llm-loop/append-input-item.ts [message...]
 *
 * Or set PROMPT / BASE_URL / STREAM_PATH.
 */
import { createEventsClient } from "../../lib/sdk.ts";
import { INPUT_ITEM_ADDED_TYPE, type InputItemAddedPayload } from "./event-types.ts";
import { toJSONObject } from "./json-object.ts";

const BASE_URL = process.env.BASE_URL || "https://events.iterate.com";
const STREAM_PATH = process.env.STREAM_PATH || "/jonas/basic-llm-loop";

const message =
  process.argv.slice(2).join(" ").trim() ||
  process.env.PROMPT ||
  "Say hello in one short sentence.";

const client = createEventsClient(BASE_URL);

const payload: InputItemAddedPayload = {
  item: { role: "user", content: message },
};

const result = await client.append({
  path: STREAM_PATH,
  events: [
    {
      path: STREAM_PATH,
      type: INPUT_ITEM_ADDED_TYPE,
      payload: toJSONObject(payload),
    },
  ],
});

console.log(JSON.stringify(result, null, 2));
