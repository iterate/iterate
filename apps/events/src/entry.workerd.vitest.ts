import { createSchedulingTestDurableObjects } from "~/durable-objects/scheduling.ts";
import { StreamDurableObject } from "~/durable-objects/stream.ts";

const {
  TestScheduleStreamDurableObject,
  TestStartupScheduleExplicitFalseStreamDurableObject,
  TestStartupScheduleNoWarnStreamDurableObject,
  TestStartupScheduleWarnStreamDurableObject,
} = createSchedulingTestDurableObjects(StreamDurableObject);

export default {
  fetch() {
    return new Response("ok");
  },
};

export {
  StreamDurableObject,
  TestScheduleStreamDurableObject,
  TestStartupScheduleExplicitFalseStreamDurableObject,
  TestStartupScheduleNoWarnStreamDurableObject,
  TestStartupScheduleWarnStreamDurableObject,
};
