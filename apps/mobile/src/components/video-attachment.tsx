// Video attachments drawn like photos: a real thumbnail (first frame via
// expo-video-thumbnails) with a play badge, in the mosaic or alone. Tapping
// opens full-screen playback with social-media-style chrome: swipe down to
// dismiss, tap to toggle the (minimal, for-now) chrome — save to Photos and
// play/pause. This chrome is where basic video editing will eventually
// live.

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useVideoPlayer, VideoView } from "expo-video";
import { Animated, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { AgentUiFileAttachment } from "../lib/feed.ts";
import { saveMediaToCameraRoll } from "../lib/save-to-camera-roll.ts";
import { videoThumbnailQuery } from "../lib/video-thumbnails.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;

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
  const [chromeVisible, setChromeVisible] = useState(false);
  const [paused, setPaused] = useState(false);
  const player = useVideoPlayer(props.url, (instance) => {
    instance.loop = true;
    instance.play();
  });
  const download = useMutation({ mutationFn: () => saveMediaToCameraRoll(props.url, "mp4") });
  const translateY = useRef(new Animated.Value(0)).current;

  const pan = Gesture.Pan()
    .runOnJS(true)
    .onUpdate((event) => translateY.setValue(Math.max(0, event.translationY)))
    .onEnd((event) => {
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        props.onClose();
      } else {
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
      }
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd(() => setChromeVisible((visible) => !visible));

  return (
    <Modal animationType="fade" onRequestClose={props.onClose} transparent visible>
      {/* Modals get their own native window, so gestures need a fresh root. */}
      <GestureHandlerRootView style={styles.fullscreen}>
        <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
          <Animated.View style={[styles.videoWrap, { transform: [{ translateY }] }]}>
            <VideoView
              contentFit="contain"
              nativeControls={false}
              player={player}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
            {chromeVisible ? (
              <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                <Pressable
                  accessibilityLabel="Save to camera roll"
                  accessibilityRole="button"
                  disabled={download.isPending || download.isSuccess}
                  hitSlop={12}
                  onPress={() => download.mutate()}
                  style={[styles.chromeButton, { top: insets.top + spacing.sm }]}
                >
                  {download.isPending ? (
                    <Text style={styles.chromeGlyph}>…</Text>
                  ) : download.isSuccess ? (
                    <Ionicons name="checkmark" size={22} color={colors.text} />
                  ) : (
                    <Ionicons name="download-outline" size={22} color={colors.text} />
                  )}
                </Pressable>
                <View pointerEvents="box-none" style={styles.playPauseWrap}>
                  <Pressable
                    accessibilityLabel={paused ? "Play" : "Pause"}
                    accessibilityRole="button"
                    onPress={() => {
                      if (paused) player.play();
                      else player.pause();
                      setPaused(!paused);
                    }}
                    style={styles.playBadge}
                  >
                    <Ionicons
                      name={paused ? "play" : "pause"}
                      size={22}
                      color={colors.text}
                      style={paused ? styles.playGlyphNudge : undefined}
                    />
                  </Pressable>
                </View>
                {download.isError ? (
                  <Text style={[styles.downloadError, { top: insets.top + spacing.sm + 42 }]}>
                    {String((download.error as Error).message)}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
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
  videoWrap: { flex: 1 },
  chromeButton: {
    position: "absolute",
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0fa8",
    alignItems: "center",
    justifyContent: "center",
  },
  chromeGlyph: { color: colors.text, fontSize: 16 },
  playPauseWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  downloadError: {
    position: "absolute",
    right: spacing.md,
    color: colors.danger,
    fontSize: 12,
    textAlign: "right",
    maxWidth: 220,
  },
});
