import { describe, expect, test } from "vitest";
import { parseDeployCommandArgs } from "./deploy-command.ts";

describe("parseDeployCommandArgs", () => {
  test("parses the builtin deploy flags", () => {
    const parsed = parseDeployCommandArgs([
      "--file",
      "./processor.ts",
      "--stream-path",
      "/jonas/agent",
      "--project-slug",
      "demo",
      "--no-nodejs-compat",
    ]);

    expect(parsed).toEqual({
      help: false,
      input: {
        file: "./processor.ts",
        streamPath: "/jonas/agent",
        projectSlug: "demo",
        nodejsCompat: false,
      },
    });
  });

  test("accepts the legacy deploy processor alias and camelCase flags", () => {
    const parsed = parseDeployCommandArgs([
      "processor",
      "--file",
      "./processor.ts",
      "--streamPath",
      "/jonas/agent",
      "--processorExportName",
      "agentProcessor",
      "--outboundGateway",
      "false",
    ]);

    expect(parsed).toEqual({
      help: false,
      input: {
        file: "./processor.ts",
        streamPath: "/jonas/agent",
        processorExportName: "agentProcessor",
        outboundGateway: false,
      },
    });
  });

  test("returns help without parsing the rest of the argv", () => {
    const parsed = parseDeployCommandArgs(["--help"]);

    expect(parsed).toEqual({
      help: true,
      input: {},
    });
  });
});
