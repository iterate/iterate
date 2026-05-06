import { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";

export default {
  fetch() {
    return new Response("ok");
  },
};

export { StreamDurableObject };
