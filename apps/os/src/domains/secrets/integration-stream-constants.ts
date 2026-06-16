import { StreamPath } from "@iterate-com/shared/streams/types";

export const SLACK_INTEGRATION_PROCESSOR_SLUG = "slack";
export const GOOGLE_INTEGRATION_PROCESSOR_SLUG = "google-integration";

export const SLACK_INTEGRATION_STREAM_PATH = StreamPath.parse("/integrations/slack");
export const GOOGLE_INTEGRATION_STREAM_PATH = StreamPath.parse("/integrations/google");

export const SLACK_CONNECTED_EVENT_TYPE = "events.iterate.com/slack/connected";
export const SLACK_DISCONNECTED_EVENT_TYPE = "events.iterate.com/slack/disconnected";
export const GOOGLE_CONNECTED_EVENT_TYPE = "events.iterate.com/google-integration/connected";
export const GOOGLE_DISCONNECTED_EVENT_TYPE = "events.iterate.com/google-integration/disconnected";
