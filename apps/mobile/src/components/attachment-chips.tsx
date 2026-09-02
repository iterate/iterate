// The pending-attachment row above the composer's text field: one thumbnail
// per attachment, flush like the sheet's filmstrip, nothing auto-sends.
// The ✕ in each tile's corner removes it (behind the Remove attachment?
// confirmation); tapping the tile itself previews it full screen — the SAME
// MediaViewer already-sent photos open in (pinch/zoom, swipe down to
// dismiss) and the same fullscreen player videos use. One day markup
// (drawing on the preview, messenger-style) can hang off that viewer.

import { useState } from "react";
import { Alert, Image, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  attachmentKey,
  attachmentLabel,
  formatClipDuration,
  type ComposerAttachment,
} from "../lib/composer-attachments.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { MediaViewer } from "./media-viewer.tsx";
import { FullscreenVideoModal } from "./video-attachment.tsx";

const TILE = 84;

export function AttachmentChips(props: {
  attachments: ComposerAttachment[];
  onRemove: (key: string) => void;
}) {
  const [preview, setPreview] = useState<ComposerAttachment | null>(null);
  if (props.attachments.length === 0) return null;
  return (
    <View style={styles.strip}>
      {props.attachments.map((attachment) => {
        const key = attachmentKey(attachment);
        const label = attachmentLabel(attachment);
        const previewable = attachment.kind === "photo" || attachment.kind === "video";
        return (
          <View key={key} style={styles.tile}>
            <Pressable
              accessibilityLabel={`Attachment: ${label}`}
              accessibilityRole={previewable ? "button" : "none"}
              onPress={previewable ? () => setPreview(attachment) : undefined}
              style={styles.tileBody}
            >
              <Chip attachment={attachment} />
            </Pressable>
            <Pressable
              accessibilityLabel={`Remove ${label}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={async () => {
                if (await confirmRemoval(label)) props.onRemove(key);
              }}
              style={styles.removeBadge}
            >
              <Ionicons name="close" size={13} color={colors.text} />
            </Pressable>
          </View>
        );
      })}
      {/* Full-screen preview of a not-yet-sent attachment, from local bytes —
          instant, and identical to how the sent version will look. */}
      <Modal
        animationType="none"
        onRequestClose={() => setPreview(null)}
        statusBarTranslucent
        transparent
        visible={preview?.kind === "photo"}
      >
        {preview?.kind === "photo" ? (
          <MediaViewer
            markdown=""
            onClose={() => setPreview(null)}
            tags={[]}
            title={preview.image.filename}
            uri={preview.image.previewUri}
          />
        ) : null}
      </Modal>
      {preview?.kind === "video" ? (
        <FullscreenVideoModal onClose={() => setPreview(null)} url={preview.uri} />
      ) : null}
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
          <Ionicons name="mic" size={26} color={colors.textMuted} />
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
          <Ionicons name="document-outline" size={26} color={colors.textMuted} />
          <Text numberOfLines={2} style={styles.glyphCaption}>
            {attachment.filename}
          </Text>
        </View>
      );
    case "location":
      return (
        <View style={styles.thumbBox}>
          <Ionicons name="location" size={26} color={colors.accent} />
          <Text style={styles.glyphCaption}>here</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    // Flush like the sheet's filmstrip: 1px of page background as divider.
    gap: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  tile: {
    width: TILE,
    height: TILE,
  },
  tileBody: { width: TILE, height: TILE, overflow: "hidden" },
  thumb: {
    width: TILE,
    height: TILE,
  },
  thumbBox: {
    width: TILE,
    height: TILE,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    gap: 3,
  },
  removeBadge: {
    position: "absolute",
    top: 3,
    right: 3,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0fcc",
    alignItems: "center",
    justifyContent: "center",
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
    fontSize: 9,
    maxWidth: TILE - 8,
    textAlign: "center",
  },
});
