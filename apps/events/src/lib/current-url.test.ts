import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  getGlobalStartContext: vi.fn(),
}));

import { getGlobalStartContext } from "@tanstack/react-start";
import { resolveLocationUrl } from "~/lib/current-url.ts";

const getGlobalStartContextMock = vi.mocked(getGlobalStartContext);

describe("resolveLocationUrl", () => {
  afterEach(() => {
    getGlobalStartContextMock.mockReset();
  });

  test("uses the current request URL as the base during SSR", () => {
    getGlobalStartContextMock.mockReturnValue({
      rawRequest: new Request("https://alpha.events.iterate.com/streams/?projectSlug=beta"),
    } as ReturnType<typeof getGlobalStartContext>);

    const url = resolveLocationUrl("/streams/?projectSlug=beta");

    expect(url.toString()).toBe("https://alpha.events.iterate.com/streams/?projectSlug=beta");
  });

  test("falls back to localhost when no request context is available", () => {
    getGlobalStartContextMock.mockReturnValue(undefined);

    const url = resolveLocationUrl("/streams/?projectSlug=beta");

    expect(url.toString()).toBe("http://localhost/streams/?projectSlug=beta");
  });
});
