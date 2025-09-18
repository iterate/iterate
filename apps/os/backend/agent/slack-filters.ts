import type { SlackEvent } from "@slack/types";

/**
 * Keys to blacklist from Slack webhook payloads before adding to developer messages.
 * Supports both simple keys and nested paths:
 * - "blocks" - removes all "blocks" keys at any depth
 * - "user.profile" - removes "profile" key only when nested under "user"
 * - "files.*.thumb_url" - removes "thumb_url" from any object in "files" array
 */
const SLACK_WEBHOOK_BLACKLIST = [
  // User/bot metadata that's rarely needed
  "bot_profile",
  "icons",
  "is_bot",

  // Team/workspace info
  "team_id",
  "team_domain",
  "enterprise_id",
  "enterprise_name",

  // App/integration details
  "app_id",
  "app_installed_team_id",
  "source_team",
  "user_team",
  "connector_id",

  // Internal Slack metadata
  "is_ext_shared_channel",

  // Image URLs and thumbnails (now with nested path support)
  "image_url",
  "thumb_url",
  "thumb_64",
  "thumb_80",
  "thumb_160",
  "thumb_360",
  "thumb_480",
  "thumb_720",
  "thumb_800",
  "thumb_960",
  "thumb_1024",
  "avatar_url",
  "profile_image_24",
  "profile_image_32",
  "profile_image_48",
  "profile_image_72",
  "profile_image_192",
  "profile_image_512",
  "url_private",
  "url_private_download",
  "permalink",
  "permalink_public",

  // Nested paths examples:
  "user.profile.image",
  "user.profile.avatar_hash",
  "files.*.thumbs",
  "files.*.thumb_*",
  "message.files.*.url_private",
];

/**
 * Checks if a path matches a blacklist pattern.
 * Supports wildcards (*) for array indices and partial key matching.
 */
function pathMatchesPattern(path: string[], pattern: string): boolean {
  const patternParts = pattern.split(".");

  // If pattern is longer than path, it can't match
  if (patternParts.length > path.length) {
    return false;
  }

  // Check each part of the pattern against the path
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = path[i];

    if (patternPart === "*") {
      return true;
    } else if (patternPart.includes("*")) {
      // Partial wildcard (e.g., "thumb_*")
      const regex = new RegExp(`^${patternPart.replace(/\*/g, ".*")}$`);
      if (!regex.test(pathPart)) {
        return false;
      }
    } else if (patternPart !== pathPart) {
      // Exact match required
      return false;
    }
  }

  return true;
}

/**
 * Recursively removes blacklisted keys from an object.
 * Returns a new object without modifying the original.
 *
 * @param obj The object to filter
 * @param currentPath The current path in the object tree
 */
export function filterSlackPayload(obj: any, currentPath: string[] = []): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, index) => filterSlackPayload(item, [...currentPath, String(index)]));
  }

  const filtered: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const newPath = [...currentPath, key];

    // Check if this key should be blacklisted
    let shouldBlacklist = false;

    for (const pattern of SLACK_WEBHOOK_BLACKLIST) {
      // Simple key match (works at any depth)
      if (!pattern.includes(".") && pattern === key) {
        shouldBlacklist = true;
        break;
      }
      // Nested path match
      if (pattern.includes(".") && pathMatchesPattern(newPath, pattern)) {
        shouldBlacklist = true;
        break;
      }
    }

    if (!shouldBlacklist) {
      filtered[key] = filterSlackPayload(value, newPath);
    }
  }
  return filtered;
}

// Utility functions for Slack event processing

/**
 * Determines if a Slack event should be included in the agent's conversation context.
 * This is called within the reducer when processing SLACK:WEBHOOK_EVENT_RECEIVED events
 * to decide whether the event should be added to inputItems for LLM processing.
 *
 * Uses exhaustive matching to ensure all event types are explicitly handled.
 *
 * @param slackEvent The Slack event to check
 * @param botUserId The bot's user ID to filter out its own messages
 * @returns true if the event should be added to inputItems, false if it should be skipped
 */
export function shouldIncludeEventInConversation(
  slackEvent: SlackEvent | undefined,
  botUserId: string | undefined,
): boolean {
  if (!slackEvent) {
    return false;
  }

  // Filter out events from the bot itself
  if (botUserId && "user" in slackEvent && slackEvent.user === botUserId) {
    return false;
  }

  // Exhaustive switch on event types
  switch (slackEvent.type) {
    // ===== Currently included event types =====
    case "message": {
      const messageEvent = slackEvent as any;
      // Skip certain message subtypes (except file_share)
      if (messageEvent.subtype && messageEvent.subtype !== "file_share") {
        return false;
      }
      return true;
    }

    case "reaction_added":
    case "reaction_removed":
      // Reactions are included in context but don't trigger LLM computation
      return true;

    // ===== Event types we explicitly choose to ignore =====
    // User/member events - too noisy, not conversational
    case "user_change":
    case "member_joined_channel":
    case "member_left_channel":
      return false;

    // Channel management events - administrative, not conversational
    case "channel_created":
    case "channel_deleted":
    case "channel_rename":
    case "channel_archive":
    case "channel_unarchive":
    case "channel_history_changed":
    case "channel_shared":
    case "channel_unshared":
      return false;

    // File events (except file_share within messages)
    case "file_created":
    case "file_change":
    case "file_deleted":
    case "file_public":
    case "file_shared":
    case "file_unshared":
      return false;

    // App/bot lifecycle events
    case "app_mention":
      // TODO: Consider including app_mention in the future for direct bot mentions
      return false;
    case "app_home_opened":
    case "app_installed":
    case "app_uninstalled":
    case "app_requested":
    case "app_deleted":
      return false;

    // Team/workspace events
    case "team_join":
    case "team_rename":
    case "team_domain_change":
      return false;

    // DM/Group events
    case "im_created":
    case "im_open":
    case "im_close":
    case "im_history_changed":
    case "group_left":
    case "group_open":
    case "group_close":
    case "group_archive":
    case "group_unarchive":
    case "group_rename":
    case "group_history_changed":
      return false;

    // Message metadata events
    case "message_metadata_posted":
    case "message_metadata_updated":
    case "message_metadata_deleted":
      return false;

    // Pin events
    case "pin_added":
    case "pin_removed":
      return false;

    // Star events
    case "star_added":
    case "star_removed":
      return false;

    // Presence/DND events
    case "dnd_updated":
    case "dnd_updated_user":
      return false;

    // Emoji events
    case "emoji_changed":
      return false;

    // Subteam (user group) events
    case "subteam_created":
    case "subteam_updated":
    case "subteam_members_changed":
    case "subteam_self_added":
    case "subteam_self_removed":
      return false;

    // Workflow events
    case "workflow_published":
    case "workflow_unpublished":
    case "workflow_deleted":
    case "workflow_step_deleted":
    case "workflow_step_execute":
      return false;

    // OAuth/permission events
    case "tokens_revoked":
      return false;

    // Link sharing events
    case "link_shared":
      // TODO: Consider including link_shared for URL unfurling in the future
      return false;

    // Call events
    case "call_rejected":
      return false;

    // Shared channel events
    case "shared_channel_invite_accepted":
    case "shared_channel_invite_approved":
    case "shared_channel_invite_declined":
    case "shared_channel_invite_received":
      return false;

    // Grid migration events
    case "grid_migration_started":
    case "grid_migration_finished":
      return false;

    // Default case for exhaustive checking
    default: {
      // TypeScript's exhaustive check - if this line has an error, it means
      // there are unhandled event types that should be explicitly handled above
      const unhandledEvent: SlackEvent = slackEvent;
      console.warn(`Unhandled Slack event type: ${unhandledEvent.type}`);

      // For now, ignore any unhandled event types
      // When new event types are added to @slack/types, they'll appear here
      // and we can decide whether to include them in conversations
      return false;
    }
  }
}

/**
 * Determines if a Slack event should trigger an LLM computation.
 * This is called within the reducer after an event has been added to inputItems
 * to decide whether to set triggerLLMRequest=true.
 *
 * Currently only message events trigger LLM computation (unless paused).
 * Reaction events are added to context but don't trigger immediate LLM requests.
 *
 * @param slackEvent The Slack event to check
 * @param isPaused Whether LLM requests are currently paused
 * @returns true if the event should trigger LLM computation
 */
export function shouldTriggerLLMComputation(
  slackEvent: SlackEvent | undefined,
  isPaused: boolean,
): boolean {
  // Only trigger on message events when not paused
  return slackEvent?.type === "message" && !isPaused;
}
