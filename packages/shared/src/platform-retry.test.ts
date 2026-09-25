import { expect, test } from "vitest";
import { HttpAnswerError, httpPlatformFailure } from "./platform-retry.ts";

test.for([
  {
    name: "a dropped connection is the platform's",
    error: new TypeError("fetch failed"),
    failure: { what: "get key", status: "network", message: "fetch failed" },
  },
  {
    name: "a 503 is the platform's",
    error: new HttpAnswerError("HTTP 503", 503),
    failure: { what: "get key", status: 503, message: "HTTP 503" },
  },
  {
    name: "a 429 is the platform's",
    error: new HttpAnswerError("HTTP 429", 429),
    failure: { what: "get key", status: 429, message: "HTTP 429" },
  },
  { name: "a 404 is an answer", error: new HttpAnswerError("HTTP 404", 404), failure: undefined },
  {
    name: "a timeout is the caller's",
    error: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    failure: undefined,
  },
  { name: "any other error is thrown as it is", error: new Error("boom"), failure: undefined },
])("httpPlatformFailure: $name", ({ error, failure }) => {
  expect(httpPlatformFailure(error, { what: "get key" })).toEqual(failure);
});
