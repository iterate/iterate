import assert from "node:assert/strict";
import {
  createWorkshopTestHarness,
  runWorkshopMain,
  type Event,
  type StreamPath,
} from "ai-engineer-workshop";
import relativePingPongProcessor from "./relative-ping-pong-processor.ts";

export async function run() {
  const app = createWorkshopTestHarness();
  const workerPath = app.createTestChildStreamPath({
    testName: "relative-ping-pong",
    childSlug: "worker",
  });
  const parentPath = toParentPath(workerPath);
  const childPath = `${workerPath}/child` as StreamPath;
  const runner = await app.startProcessors({
    processors: [relativePingPongProcessor],
    streamPath: workerPath,
  });

  try {
    const parentPing = await app.append({
      path: workerPath,
      event: {
        type: "ping",
        payload: { message: "please answer from the parent stream" },
      },
    });
    const childPing = await app.append({
      path: workerPath,
      event: {
        type: "ping",
        payload: { message: "please answer from the child stream" },
      },
    });

    const parentPong = await app.waitForEvent({
      streamPath: parentPath,
      predicate: (event) =>
        event.type === "pong" &&
        readReplyToOffset(event) === parentPing.event.offset &&
        readLocation(event) === "parent",
    });
    const childPong = await app.waitForEvent({
      streamPath: childPath,
      predicate: (event) =>
        event.type === "pong" &&
        readReplyToOffset(event) === childPing.event.offset &&
        readLocation(event) === "child",
    });

    const workerEvents = await app.collectEvents(workerPath);
    assert.equal(
      workerEvents.some((event) => event.type === "pong"),
      false,
    );

    console.log(`Base URL: ${app.baseUrl}`);
    console.log(`Worker stream: ${workerPath}`);
    console.log(`Parent pong path: ${parentPath}`);
    console.log(`Child pong path: ${childPath}`);
    console.log("Proof events:");
    console.log(JSON.stringify([parentPong, childPong], null, 2));
    console.log("proof passed");
  } finally {
    await runner.stopAndWait();
  }
}

function toParentPath(path: StreamPath) {
  const segments = path.split("/").filter(Boolean);
  return `/${segments.slice(0, -1).join("/")}` as StreamPath;
}

function readReplyToOffset(event: Event) {
  const value = Reflect.get(event.payload, "replyToOffset");
  return typeof value === "number" ? value : null;
}

function readLocation(event: Event) {
  const value = Reflect.get(event.payload, "location");
  return typeof value === "string" ? value : null;
}

runWorkshopMain(import.meta.url, run);
