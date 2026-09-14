// Video attachments drawn like photos: a real thumbnail (first frame via
// expo-video-thumbnails) with a play badge, in the mosaic or alone. Tapping
// opens full-screen playback (expo-video + native controls).

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useVideoPlayer, VideoView } from "expo-video";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AgentUiFileAttachment } from "../lib/feed.ts";
import { videoThumbnailQuery } from "../lib/video-thumbnails.ts";
import { saveMediaToCameraRoll } from "../lib/save-to-camera-roll.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

/** Fills whatever frame its parent gives it (a mosaic rect or a solo photo
 * frame): thumbnail, play badge, tap → full screen. */
export function VideoTile(props: {
  file: AgentUiFileAttachment;
  style: React.ComponentProps<typeof Pressable>["style"];
}) {
  const [playing, setPlaying] = useState(false);
  const thumbnail = useQuery(videoThumbnailQuery(props.file.url));
  return (
    <Pressable
      accessibilityLabel={`Play video ${props.file.filename}`}
      accessibilityRole="button"
      onPress={() => setPlaying(true)}
      style={props.style}
    >
      {thumbnail.data ? (
        <Image
          resizeMode="cover"
          source={{ uri: thumbnail.data.uri }}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
      )}
      <View pointerEvents="none" style={styles.playBadgeWrap}>
        <View style={styles.playBadge}>
          <Ionicons name="play" size={22} color={colors.text} style={styles.playGlyphNudge} />
        </View>
      </View>
      {playing ? (
        <FullscreenVideoModal onClose={() => setPlaying(false)} url={props.file.url} />
      ) : null}
    </Pressable>
  );
}

/** Also the composer chips' video preview — any playable uri works, local
 * files included. */
export function FullscreenVideoModal(props: { onClose: () => void; url: string }) {
  const insets = useSafeAreaInsets();
  const download = useMutation({ mutationFn: () => saveMediaToCameraRoll(props.url, "mp4") });
  const player = useVideoPlayer(props.url, (instance) => {
    instance.play();
  });
  return (
    <Modal animationType="fade" onRequestClose={props.onClose} visible>
      <View style={styles.fullscreen}>
        <View style={[styles.toolbar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            accessibilityLabel="Save to camera roll"
            accessibilityRole="button"
            disabled={download.isPending || download.isSuccess}
            hitSlop={12}
            onPress={() => download.mutate()}
            style={styles.control}
          >
            <Ionicons
              name={download.isSuccess ? "checkmark" : "download-outline"}
              size={22}
              color={colors.text}
            />
            <Text style={styles.controlText}>
              {download.isPending ? "Saving…" : download.isSuccess ? "Saved" : "Save"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Close video"
            accessibilityRole="button"
            hitSlop={12}
            onPress={props.onClose}
            style={styles.control}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
        </View>
        {download.isError ? (
          <Text accessibilityRole="alert" style={styles.downloadError}>
            {download.error.message}
          </Text>
        ) : null}
        <VideoView
          allowsFullscreen
          contentFit="contain"
          nativeControls
          player={player}
          style={styles.video}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  placeholder: { backgroundColor: colors.surfaceRaised },
  playBadgeWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  playBadge: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0fa8",
    alignItems: "center",
    justifyContent: "center",
  },
  playGlyphNudge: { transform: [{ translateX: 2 }] },
  fullscreen: { flex: 1, backgroundColor: "#000" },
  video: { flex: 1 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  control: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 40 },
  controlText: { color: colors.text },
  downloadError: { color: colors.danger, paddingHorizontal: spacing.md, fontSize: 12 },
});
