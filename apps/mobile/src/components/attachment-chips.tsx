// The pending-attachment row above the chat composer's text field: one
// thumbnail per attachment, nothing auto-sends. Tapping a chip asks
// "Remove attachment?" OK|Cancel (deliberate friction — the old tap-removes-
// instantly behavior ate photos people meant to preview).

import { Alert, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  attachmentKey,
  attachmentLabel,
  formatClipDuration,
  type ComposerAttachment,
} from "../lib/composer-attachments.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function AttachmentChips(props: {
  attachments: ComposerAttachment[];
  onRemove: (key: string) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <View style={styles.strip}>
      {props.attachments.map((attachment) => {
        const key = attachmentKey(attachment);
        return (
          <Pressable
            accessibilityLabel={`Attachment: ${attachmentLabel(attachment)}. Tap to remove.`}
            accessibilityRole="button"
            key={key}
            onPress={async () => {
              if (await confirmRemoval(attachmentLabel(attachment))) props.onRemove(key);
            }}
          >
            <Chip attachment={attachment} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Native gets the OK|Cancel alert; web gets window.confirm — the same
 * dialog a playwright spec answers (lib/reject-reason.ts precedent). */
function confirmRemoval(label: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`Remove attachment?\n${label}`));
  }
  return new Promise((resolve) => {
    Alert.alert("Remove attachment?", label, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "OK", onPress: () => resolve(true) },
    ]);
  });
}

function Chip({ attachment }: { attachment: ComposerAttachment }) {
  switch (attachment.kind) {
    case "photo":
      return <Image source={{ uri: attachment.image.previewUri }} style={styles.thumb} />;
    case "video":
      return (
        <View style={styles.thumbBox}>
          {attachment.previewUri !== null ? (
            <Image source={{ uri: attachment.previewUri }} style={StyleSheet.absoluteFill} />
          ) : null}
          <View style={styles.mediaBadge}>
            <Ionicons name="play" size={10} color={colors.text} />
            {attachment.durationSeconds !== null ? (
              <Text style={styles.badgeText}>{formatClipDuration(attachment.durationSeconds)}</Text>
            ) : null}
          </View>
        </View>
      );
    case "audio":
      return (
        <View style={styles.thumbBox}>
          <Ionicons name="mic" size={20} color={colors.textMuted} />
          {attachment.durationSeconds !== null ? (
            <Text style={styles.glyphCaption}>
              {formatClipDuration(attachment.durationSeconds)}
            </Text>
          ) : null}
        </View>
      );
    case "file":
      return (
        <View style={styles.thumbBox}>
          <Ionicons name="document-outline" size={20} color={colors.textMuted} />
          <Text numberOfLines={1} style={styles.glyphCaption}>
            {attachment.filename}
          </Text>
        </View>
      );
    case "location":
      return (
        <View style={styles.thumbBox}>
          <Ionicons name="location" size={20} color={colors.accent} />
          <Text style={styles.glyphCaption}>here</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  thumbBox: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    gap: 2,
  },
  mediaBadge: {
    position: "absolute",
    bottom: 3,
    left: 3,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: "#0b0b0fbb",
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  badgeText: { color: colors.text, fontSize: 9 },
  glyphCaption: {
    color: colors.textFaint,
    fontSize: 8,
    maxWidth: 48,
    textAlign: "center",
  },
});
