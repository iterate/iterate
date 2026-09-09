import { afterEach, describe, expect, test, vi } from "vitest";
import { prototypeWorkspaceResponse } from "./workspace-prototype-response.ts";

const disconnected = () =>
  Object.assign(new Error("Network connection lost."), { retryable: true });
afterEach(() => vi.restoreAllMocks());

describe("prototype workspace HTTP transport", () => {
  test.each(["RPC", "body"])(
    "retries one %s disconnection before returning complete JSON",
    async (failure) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      let calls = 0;
      const response = await prototypeWorkspaceResponse(
        new Request("http://workspace.internal/manifest"),
        async () => {
          if (++calls === 1) {
            if (failure === "RPC") throw disconnected();
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(disconnected());
                },
              }),
            );
          }
          return Response.json({ files: ["source.txt"] });
        },
      );
      expect(await response.json()).toEqual({ files: ["source.txt"] });
      expect(calls).toBe(2);
      expect(warning).toHaveBeenCalledOnce();
    },
  );

  test("bounds a persistent read failure to two attempts and returns an explicit failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatch = vi.fn(async () => {
      throw disconnected();
    });
    const response = await prototypeWorkspaceResponse(
      new Request("http://workspace.internal/manifest"),
      dispatch,
    );
    expect(response.status).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledOnce();
  });

  test.each(["PUT", "DELETE"])("does not repeat a failed %s mutation", async (method) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatch = vi.fn(async () => {
      throw disconnected();
    });
    const response = await prototypeWorkspaceResponse(
      new Request("http://workspace.internal/file", { method }),
      dispatch,
    );
    expect(response.status).toBe(503);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test.each([new Error("unexpected defect"), Object.assign(disconnected(), { overloaded: true })])(
    "does not retry defects or overloads",
    async (error) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const dispatch = vi.fn(async () => {
        throw error;
      });
      const response = await prototypeWorkspaceResponse(
        new Request("http://workspace.internal/manifest"),
        dispatch,
      );
      expect(response.ok).toBe(false);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );
});
