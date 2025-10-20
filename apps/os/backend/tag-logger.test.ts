import { expect, test } from "vitest";
import { TagLogger } from "./tag-logger.ts";

const createLogger = () => {
  const calls: any[][] = [];
  const mocks = {
    info: (...args: any[]) => calls.push(["info", ...args]),
    warn: (...args: any[]) => calls.push(["warn", ...args]),
    error: (...args: any[]) => calls.push(["error", ...args]),
    debug: (...args: any[]) => calls.push(["debug", ...args]),
  };
  return {
    mocks,
    calls,
    logger: new TagLogger(mocks),
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
    logger.debug("dbg-one", { input });
    logger.run("depth=prettydeep", () => {
      logger.debug("dbg-two", { depth: 1 });
      logger.run("depth=deeper", () => {
        if (input > 0.5) {
          logger.warn("pretty big input");
        }
      });
    });
  };
  logger.run("numero=uno", () => one(0.1));

  expect(calls).toEqual([]); // no logs, because there was no warning, so no need to recall logger.debug(...) calls

  logger.run("numero=dos", () => one(0.9));

  expect(calls).toEqual([
    [
      "warn",
      "[numero=dos][depth=prettydeep][depth=deeper]",
      "pretty big input",
      "memories:",
      [expect.stringMatching(/^2.*/), "debug", "[numero=dos]", "dbg-one", { input: 0.9 }],
      [
        expect.stringMatching(/^2.*/),
        "debug",
        "[numero=dos][depth=prettydeep]",
        "dbg-two",
        { depth: 1 },
      ],
    ],
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
