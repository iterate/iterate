import type { Browser, CDPSession, HandoffCompleteResponse, Page } from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";
import { BrowserHandoffSession } from "./browser-handoff-session.ts";

class FakeCdp {
  active = false;
  completeDuringHandoff: unknown;
  handoffError: Error | undefined;
  handoffListener: ((event: HandoffCompleteResponse) => void) | undefined;
  listenerWasInstalledBeforeHandoff = false;

  async send(command: string): Promise<unknown> {
    if (command === "Cloudflare.getHandoffState") {
      return { active: this.active };
    }
    if (command === "Cloudflare.getLiveView") {
      return {
        devtoolsFrontendUrl: "https://live.cloudflare.test/session",
        id: "target-1",
        options: {},
        webSocketDebuggerUrl: "wss://live.cloudflare.test/session",
      };
    }
    if (command === "Cloudflare.handoff") {
      this.listenerWasInstalledBeforeHandoff = this.handoffListener !== undefined;
      if (this.completeDuringHandoff !== undefined) {
        this.completeUnknown(this.completeDuringHandoff);
      }
      if (this.handoffError !== undefined) throw this.handoffError;
      return { handoffId: "handoff-1", targetId: "target-1" };
    }
    throw new Error(`Unexpected CDP command ${command}`);
  }

  once(event: string, listener: (response: HandoffCompleteResponse) => void): FakeCdp {
    if (event !== "Cloudflare.handoffComplete") throw new Error(`Unexpected CDP event ${event}`);
    this.handoffListener = listener;
    return this;
  }

  off(event: string, listener: (response: HandoffCompleteResponse) => void): FakeCdp {
    if (event === "Cloudflare.handoffComplete" && this.handoffListener === listener) {
      this.handoffListener = undefined;
    }
    return this;
  }

  complete(response: HandoffCompleteResponse): void {
    this.completeUnknown(response);
  }

  completeUnknown(response: unknown): void {
    const listener = this.handoffListener;
    this.handoffListener = undefined;
    listener?.(response as HandoffCompleteResponse);
  }
}

class FakeBrowser {
  closed = false;
  closeCalls = 0;
  disconnected = false;
  disconnectedListener: (() => void) | undefined;

  on(event: string, listener: () => void): FakeBrowser {
    if (event !== "disconnected") throw new Error(`Unexpected browser event ${event}`);
    this.disconnectedListener = listener;
    return this;
  }

  off(event: string, listener: () => void): FakeBrowser {
    if (event === "disconnected" && this.disconnectedListener === listener) {
      this.disconnectedListener = undefined;
    }
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.disconnected) throw new Error("Cannot close a disconnected browser.");
    this.closed = true;
  }

  disconnect(): void {
    this.disconnected = true;
    this.disconnectedListener?.();
  }
}

class FakePage {
  currentTitle = "Sign in";
  currentUrl = "https://example.test/login";

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async evaluate(): Promise<string> {
    return "page text";
  }
}

function createSession() {
  const browser = new FakeBrowser();
  const cdp = new FakeCdp();
  const page = new FakePage();
  const session = new BrowserHandoffSession({
    // These fakes deliberately implement only the browser methods used by the
    // controller; the casts keep the production boundary on Puppeteer's exact
    // types without dragging its large abstract classes into the unit test.
    browser: browser as unknown as Browser,
    cdp: cdp as unknown as CDPSession,
    page: page as unknown as Page,
  });
  return { browser, cdp, page, session };
}

describe("BrowserHandoffSession", () => {
  it("installs the completion listener before starting and resumes the same page", async () => {
    const { cdp, page, session } = createSession();
    cdp.completeDuringHandoff = {
      handoffId: "handoff-1",
      success: true,
      targetId: "target-1",
    };

    const handoff = await session.startHandoff({
      instructions: "Sign in, then click Done.",
      timeoutMs: 30_000,
    });
    page.currentTitle = "Dashboard";
    page.currentUrl = "https://example.test/dashboard";
    const result = await session.waitForHandoff(handoff.handoffId);

    expect(cdp.listenerWasInstalledBeforeHandoff).toBe(true);
    expect(handoff.liveViewUrl).toBe("https://live.cloudflare.test/session");
    expect(result).toEqual({
      handoffId: "handoff-1",
      page: {
        title: "Dashboard",
        url: "https://example.test/dashboard",
      },
      protocolAnomaly: undefined,
      reason: undefined,
      sessionActive: true,
      success: true,
      targetId: "target-1",
    });
  });

  it("preserves completion when its in-flight handoff command rejects", async () => {
    const { cdp, session } = createSession();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    cdp.completeDuringHandoff = {
      success: true,
      targetId: "target-1",
    };
    cdp.handoffError = new Error("start acknowledgement was lost");

    const handoff = await session.startHandoff({ instructions: "Complete the challenge." });

    await expect(session.waitForHandoff(handoff.handoffId)).resolves.toMatchObject({
      handoffId: handoff.handoffId,
      protocolAnomaly: "start-command-rejected-after-completion",
      success: true,
    });
    expect(errorLog).toHaveBeenCalledWith(
      "Browser Run handoff command rejected after completion",
      expect.objectContaining({ handoffId: handoff.handoffId }),
    );
    errorLog.mockRestore();
  });

  it("refuses both remote and locally pending concurrent handoffs", async () => {
    const remote = createSession();
    remote.cdp.active = true;
    await expect(
      remote.session.startHandoff({ instructions: "Complete the challenge." }),
    ).rejects.toThrow(/reports an active handoff/);

    const local = createSession();
    await local.session.startHandoff({ instructions: "Complete the challenge." });
    await expect(
      local.session.startHandoff({ instructions: "Start another challenge." }),
    ).rejects.toThrow(/already has a handoff/);
    await local.session.close();
  });

  it("preserves an explicit Failed result for the agent to classify", async () => {
    const { cdp, session } = createSession();
    const handoff = await session.startHandoff({ instructions: "Approve the purchase." });
    cdp.complete({
      handoffId: handoff.handoffId,
      reason: "The amount is incorrect.",
      success: false,
      targetId: "target-1",
    });

    await expect(session.waitForHandoff(handoff.handoffId)).resolves.toMatchObject({
      reason: "The amount is incorrect.",
      sessionActive: true,
      success: false,
    });
  });

  it("rejects malformed completion events at the external protocol boundary", async () => {
    const { cdp, session } = createSession();
    const handoff = await session.startHandoff({ instructions: "Complete the challenge." });
    cdp.completeUnknown({ success: true, targetId: 42 });

    await expect(session.waitForHandoff(handoff.handoffId)).rejects.toThrow(
      /invalid handoff completion/,
    );
  });

  it("rejects a malformed completion that races a successful start acknowledgement", async () => {
    const { cdp, session } = createSession();
    cdp.completeDuringHandoff = { success: true, targetId: 42 };

    await expect(session.startHandoff({ instructions: "Complete the challenge." })).rejects.toThrow(
      /invalid handoff completion/,
    );
  });

  it("preserves a settled human result if Browser Run disconnects before consumption", async () => {
    const { browser, cdp, session } = createSession();
    const handoff = await session.startHandoff({ instructions: "Complete the challenge." });
    cdp.complete({
      handoffId: handoff.handoffId,
      success: true,
      targetId: "target-1",
    });
    browser.disconnect();

    await expect(session.waitForHandoff(handoff.handoffId)).resolves.toEqual({
      handoffId: handoff.handoffId,
      page: undefined,
      protocolAnomaly: undefined,
      reason: undefined,
      sessionActive: false,
      success: true,
      targetId: "target-1",
    });
    await expect(session.close()).resolves.toBeUndefined();
    expect(browser.closeCalls).toBe(0);
  });

  it("closes the browser and rejects a handoff waiter on disposal", async () => {
    const { browser, session } = createSession();
    const handoff = await session.startHandoff({ instructions: "Complete the challenge." });
    const waiting = session.waitForHandoff(handoff.handoffId);

    await session.close();

    expect(browser.closed).toBe(true);
    await expect(waiting).rejects.toThrow(/closed during human handoff/);
  });

  it("validates the handoff lifetime against Browser Run keep-alive", async () => {
    const { session } = createSession();
    await expect(
      session.startHandoff({
        instructions: "Complete the challenge.",
        timeoutMs: 9 * 60_000 + 1,
      }),
    ).rejects.toThrow(/timeoutMs must be an integer from 1 to 540000/);
  });

  it("fails boundedly if Browser Run omits the completion event", async () => {
    vi.useFakeTimers();
    try {
      const { session } = createSession();
      const handoff = await session.startHandoff({
        instructions: "Complete the challenge.",
        timeoutMs: 1_000,
      });
      const waiting = session.waitForHandoff(handoff.handoffId);
      const rejection = expect(waiting).rejects.toThrow(
        /did not emit handoffComplete within 6000ms/,
      );

      await vi.advanceTimersByTimeAsync(6_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
