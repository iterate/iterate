import { WebClient } from "@slack/web-api";

// This file uses @slack/web-api which is only installed in THIS package
// The server package does NOT have this dependency

export function getSlackInfo() {
  // Just demonstrate we can use the Slack SDK
  const client = new WebClient("fake-token");
  return {
    message: "Slack SDK loaded successfully!",
    clientType: client.constructor.name,
    timestamp: new Date().toISOString(),
  };
}

export const config = {
  name: "my-config",
  version: "1.0.0",
};
