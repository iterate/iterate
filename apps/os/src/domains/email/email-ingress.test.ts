import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appended: [] as unknown[],
  birthCertificate: null as { config: Record<string, never> } | null,
  rejectedWith: null as string | null,
}));

vi.mock("../../env.ts", () => ({
  itxEnv: {
    PROJECT: {
      getByName: () => ({
        emailProcessor: {
          snapshot: async () => ({
            offset: 0,
            state: {
              allowedSenders: ["owner@example.com"],
              birthCertificate: mocks.birthCertificate,
            },
          }),
        },
      }),
    },
    PROJECT_DIRECTORY: {},
  },
}));
vi.mock("../../config.ts", () => ({
  parseConfig: () => ({
    email: { allowedSenders: [], requireDmarc: false },
    projectHostnameBases: ["iterate.app"],
  }),
}));
vi.mock("../../project-directory.ts", () => ({
  readProjectBySlug: async () => ({ id: "project-1", slug: "acme" }),
}));
vi.mock("../integrations/integration-streams.ts", () => ({
  integrationStreamStub: () => ({
    append: async (...events: unknown[]) => {
      mocks.appended.push(...events);
    },
  }),
}));

const { handleInboundEmail } = await import("./email-ingress.ts");
const { EMAIL_MAX_RAW_SIZE_BYTES } = await import("./utils.ts");

function inboundMessage(rawSize = 1): ForwardableEmailMessage {
  return {
    from: "owner@example.com",
    headers: new Headers({ "message-id": "<message-1@example.com>" }),
    raw: new ReadableStream(),
    rawSize,
    setReject(reason: string) {
      mocks.rejectedWith = reason;
    },
    to: "acme@iterate.app",
  } as unknown as ForwardableEmailMessage;
}

describe("handleInboundEmail", () => {
  beforeEach(() => {
    mocks.appended.length = 0;
    mocks.birthCertificate = null;
    mocks.rejectedWith = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  test("temporarily fails without appending when the email router is not born", async () => {
    await expect(handleInboundEmail(inboundMessage())).rejects.toThrow(
      "Email router for project project-1 is not ready; retry delivery.",
    );

    expect(mocks.appended).toEqual([]);
    expect(mocks.rejectedWith).toBeNull();
  });

  test("handles mail only after the email-router birth is visible", async () => {
    mocks.birthCertificate = { config: {} };

    await handleInboundEmail(inboundMessage(EMAIL_MAX_RAW_SIZE_BYTES + 1));

    expect(mocks.appended).toMatchObject([
      {
        type: "events.iterate.com/email/rejected",
        payload: { projectId: "project-1", reason: "message-too-large" },
      },
    ]);
    expect(mocks.rejectedWith).toBe("Message too large.");
  });
});
