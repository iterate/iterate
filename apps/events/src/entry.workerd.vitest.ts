import { createSchedulingTestDurableObjects } from "~/durable-objects/scheduling-test-harness.ts";
import { StreamDurableObject } from "~/durable-objects/stream.ts";

const { TestScheduleStreamDurableObject } = createSchedulingTestDurableObjects(StreamDurableObject);

export default {
  fetch() {
    return new Response("ok");
  },
};

export { StreamDurableObject, TestScheduleStreamDurableObject };
