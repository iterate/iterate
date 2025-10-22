import { expect, test } from "vitest";
import { TagLogger } from "./tag-logger.ts";

const createLogger = () => {
  const calls: any[][] = [];
  return {
    calls,
    logger: new TagLogger(function ({ level, args }) {
      calls.push([level, this.tagsString(), ...args]);
    }),
  };
};

test("logger", () => {
  const { logger, calls } = createLogger();
  const one = () => {
    logger.info("one");
  };
  logger.run("numero=uno", one);

  expect(calls).toEqual([["info", "[numero=uno]", "one"]]);
});

test("stores memories", () => {
  const { logger, calls } = createLogger();
  const one = (input: number) => {
    logger.debug("dbg-a", { input });
    logger.run("depth=prettydeep", () => {
      logger.debug("dbg-b", { depth: 1 });
      logger.run("depth=deeper", () => {
        logger.debug("dbg-c", { depth: 2 });
        if (input > 0.5) logger.warn("something concerning happened");
      });
      if (input > 0.5) logger.warn("maybe something bad happened");
    });
  };
  logger.run("numero=uno", () => one(0.1));

  expect(calls).toEqual([]); // no logs, because there was no warning, so no need to recall logger.debug(...) calls

  logger.run("numero=dos", () => one(0.9));

  logger.warn("i have a bad feeling about this");

  const isoDateRegex = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
  const expectDate = expect.stringMatching(isoDateRegex);
  expect(calls).toEqual([
    [
      "warn",
      "[numero=dos][depth=prettydeep][depth=deeper]",
      "something concerning happened",
      "memories:",
      [expectDate, "debug", "[numero=dos]", "dbg-a", { input: 0.9 }],
      [expectDate, "debug", "[numero=dos][depth=prettydeep]", "dbg-b", { depth: 1 }],
      [expectDate, "debug", "[numero=dos][depth=prettydeep][depth=deeper]", "dbg-c", { depth: 2 }],
    ],
    [
      "warn",
      "[numero=dos][depth=prettydeep]",
      "maybe something bad happened",
      "memories:",
      [expectDate, "debug", "[numero=dos]", "dbg-a", { input: 0.9 }],
      [expectDate, "debug", "[numero=dos][depth=prettydeep]", "dbg-b", { depth: 1 }],
      // no dbg-c because it was in a child context
    ],
    ["warn", "", "i have a bad feeling about this"],
  ]);
});

test("timed", async () => {
  const { logger, calls } = createLogger();
  await logger.run("requestId=req_123", async () => {
    await logger.timed.info("procedure=test", async () => {
      logger.info("step=one");
      await new Promise((resolve) => setTimeout(resolve, 20));
      logger.info("step=two");
    });
  });
  expect(calls).toEqual([
    ["info", "[requestId=req_123][procedure=test]", "step=one"],
    ["info", "[requestId=req_123][procedure=test]", "step=two"],
    ["info", "[requestId=req_123]", expect.stringMatching(/^procedure=test took \d...*ms$/)],
  ]);
});

// enterWith not supported in Cloudflare Workers
// test("enterWith", async () => {
//   const { logger, calls } = createLogger();
//   const foo = () => {
//     const one = () => {
//       logger.setTag("hello");
//       logger.info("one");
//       logger.setTag("world");
//       logger.info("one point five");
//     };
//     logger.setTag("foo");
//     logger.run("numero=uno", one);
//     logger.info("outside one()");
//   };
//   foo();

//   expect(calls).toEqual([
//     ["info", "[foo][numero=uno][hello]", "one"],
//     ["info", "[foo][numero=uno][hello][world]", "one point five"],
//     ["info", "[foo]", "outside one()"],
//   ]);
// });
