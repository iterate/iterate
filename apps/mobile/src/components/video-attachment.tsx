// Video attachments drawn like photos: a real thumbnail (first frame via
// expo-video-thumbnails) with a play badge, in the mosaic or alone. Tapping
// opens full-screen playback (expo-video + native controls).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVideoPlayer, VideoView } from "expo-video";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AgentUiFileAttachment } from "../lib/feed.ts";
import { videoThumbnailQuery } from "../lib/video-thumbnails.ts";
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

function FullscreenVideoModal(props: { onClose: () => void; url: string }) {
  const insets = useSafeAreaInsets();
  const player = useVideoPlayer(props.url, (instance) => {
    instance.play();
  });
  return (
    <Modal animationType="fade" onRequestClose={props.onClose} visible>
      <View style={styles.fullscreen}>
        <VideoView
          allowsFullscreen
          contentFit="contain"
          nativeControls
          player={player}
          style={StyleSheet.absoluteFill}
        />
        <Pressable
          accessibilityLabel="Close video"
          accessibilityRole="button"
          hitSlop={12}
          onPress={props.onClose}
          style={[styles.close, { top: insets.top + spacing.sm }]}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </Pressable>
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
  close: {
    position: "absolute",
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0f99",
    alignItems: "center",
    justifyContent: "center",
  },
});
