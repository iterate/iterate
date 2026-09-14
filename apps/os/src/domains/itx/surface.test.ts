import { describe, expect, test } from "vitest";
import { applySurface, parseItxSurface, restrictPrototype } from "./surface.ts";

describe("parseItxSurface", () => {
  test("accepts member names, dedupes, and sorts", () => {
    expect(parseItxSurface(["chat", "agent", "chat"])).toEqual(["agent", "chat"]);
  });

  test.each([[undefined], ["chat"], [[1]], [["agent.message"]], [["a b"]], [["-x"]]])(
    "rejects %j",
    (value) => {
      expect(() => parseItxSurface(value)).toThrow(/itx surface/);
    },
  );
});

describe("restrictPrototype", () => {
  // Stand-in for an RpcTarget class with a dynamic hop beneath its prototype.
  const hop = new Proxy(Object.create(Object.prototype) as object, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      return `dynamic:${key}`;
    },
  });
  class Surface {
    readonly #secret = "kept";
    get repo() {
      return `repo:${this.#secret}`;
    }
    get chat() {
      return `chat:${this.#secret}`;
    }
    __describe() {
      return "describe";
    }
  }
  Object.setPrototypeOf(Surface.prototype, hop);

  test("keeps allowed members, defers the rest to the hop, and always keeps __describe", () => {
    const instance = new Surface();
    applySurface(instance, ["chat"], Surface.prototype);
    expect(instance.chat).toBe("chat:kept");
    expect(instance.repo).toBe("dynamic:repo");
    expect(instance.__describe()).toBe("describe");
    // The class prototype stays in the chain: instanceof holds, and the
    // class's own private-accessor logic keeps working.
    expect(instance instanceof Surface).toBe(true);
  });

  test("without a hop beneath the class, a removed member throws a plain scope error", () => {
    class Plain {
      get repo() {
        return "repo";
      }
      get chat() {
        return "chat";
      }
    }
    const instance = new Plain();
    applySurface(instance, ["chat"], Plain.prototype);
    expect(instance.chat).toBe("chat");
    expect(() => instance.repo).toThrow(/"repo" is not available in this scope/);
  });

  test("memoises per prototype and surface", () => {
    expect(restrictPrototype(Surface.prototype, ["chat", "repo"])).toBe(
      restrictPrototype(Surface.prototype, ["repo", "chat"]),
    );
    expect(restrictPrototype(Surface.prototype, ["chat"])).not.toBe(
      restrictPrototype(Surface.prototype, ["repo"]),
    );
  });

  test("absent surface is a no-op", () => {
    const instance = new Surface();
    applySurface(instance, undefined, Surface.prototype);
    expect(instance.repo).toBe("repo:kept");
  });
});
