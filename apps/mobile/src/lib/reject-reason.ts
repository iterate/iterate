// Ask the human WHY they're rejecting an approval batch — optional free text
// that rides the decided event into each rejected fetch's 403 body, so the
// calling agent can retry with a change. Resolves null when the human cancels
// (the batch stays held), "" for a reasonless reject. Native gets
// Alert.prompt (iOS); web gets window.prompt — the same dialog the playwright
// spec answers.

import { Alert, Platform } from "react-native";

export function promptForRejectReason(count: number): Promise<string | null> {
  const title = count === 1 ? "Reject this request?" : `Reject all ${count} requests?`;
  const message = "Optionally tell the agent why, so it can retry differently.";
  if (Platform.OS === "web") {
    return Promise.resolve(window.prompt(`${title}\n${message}`, ""));
  }
  return new Promise((resolve) => {
    Alert.prompt(
      title,
      message,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
        { text: "Reject", style: "destructive", onPress: (text?: string) => resolve(text || "") },
      ],
      "plain-text",
    );
  });
}
