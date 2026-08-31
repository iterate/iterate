// Full-screen media viewer with social-media-style chrome: pinch to zoom,
// pan when zoomed, swipe down to dismiss (tap no longer closes — it toggles
// a chrome overlay showing tags and the description, collapsed with "See
// more" expanding into a scrollable half-screen panel). Gestures come from
// react-native-gesture-handler (already a dependency; callbacks run on the
// JS thread since reanimated is deliberately not installed) driving core
// Animated values.

import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import { colors, radius, spacing } from "../lib/theme.ts";
import { Markdown } from "./markdown.tsx";

const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;

export function MediaViewer({
  uri,
  title,
  tags,
  markdown,
  onClose,
}: {
  uri: string;
  title: string;
  tags: string[];
  markdown: string;
  onClose: () => void;
}) {
  const [chromeVisible, setChromeVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Save the viewed media to the camera roll. Remote/data uris become a
  // local cache file first — saveToLibraryAsync only takes local files.
  const download = useMutation({
    mutationFn: async () => {
      let localUri = uri;
      if (/^https?:/.test(uri)) {
        const extension = /\.(jpe?g|png|gif|webp|heic|mp4|mov|webm)(\?|$)/i.exec(uri)?.[1] || "jpg";
        const result = await FileSystem.downloadAsync(
          uri,
          `${FileSystem.cacheDirectory}download-${Date.now()}.${extension}`,
        );
        localUri = result.uri;
      } else if (uri.startsWith("data:")) {
        const match = /^data:image\/(\w+);base64,(.+)$/.exec(uri);
        if (!match) throw new Error("Unrecognized data uri");
        localUri = `${FileSystem.cacheDirectory}download-${Date.now()}.${match[1] === "jpeg" ? "jpg" : match[1]}`;
        await FileSystem.writeAsStringAsync(localUri, match[2], {
          encoding: FileSystem.EncodingType.Base64,
        });
      }
      await MediaLibrary.saveToLibraryAsync(localUri);
    },
  });
  const scale = useRef(new Animated.Value(1)).current;
  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // Committed gesture state between gestures (Animated.Value holds the live one).
  const committed = useRef({ scale: 1, x: 0, y: 0 });

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onUpdate((event) => {
      scale.setValue(Math.max(1, Math.min(6, committed.current.scale * event.scale)));
    })
    .onEnd((event) => {
      committed.current.scale = Math.max(1, Math.min(6, committed.current.scale * event.scale));
      if (committed.current.scale === 1) {
        committed.current.x = 0;
        committed.current.y = 0;
        Animated.spring(translate, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
      }
    });

  const pan = Gesture.Pan()
    .runOnJS(true)
    .onUpdate((event) => {
      if (committed.current.scale > 1.02) {
        translate.setValue({
          x: committed.current.x + event.translationX,
          y: committed.current.y + event.translationY,
        });
      } else {
        // Unzoomed: only downward drag, tracking toward dismissal.
        translate.setValue({ x: 0, y: Math.max(0, event.translationY) });
      }
    })
    .onEnd((event) => {
      if (committed.current.scale > 1.02) {
        committed.current.x += event.translationX;
        committed.current.y += event.translationY;
        return;
      }
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        onClose();
        return;
      }
      Animated.spring(translate, { toValue: { x: 0, y: 0 }, useNativeDriver: true }).start();
    });

  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd(() => setChromeVisible((visible) => !visible));

  const gestures = Gesture.Simultaneous(pinch, pan, tap);

  return (
    <View style={styles.viewer}>
      <GestureDetector gesture={gestures}>
        <Animated.Image
          accessibilityLabel="Full screen media"
          resizeMode="contain"
          source={{ uri }}
          style={[styles.image, { transform: [...translate.getTranslateTransform(), { scale }] }]}
        />
      </GestureDetector>
      {chromeVisible ? (
        <View pointerEvents="box-none" style={styles.chrome}>
          <Pressable accessibilityLabel="Close image" onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Save to camera roll"
            disabled={download.isPending || download.isSuccess}
            onPress={() => download.mutate()}
            style={styles.download}
          >
            <Text style={styles.closeText}>
              {download.isPending ? "…" : download.isSuccess ? "✓" : "⬇"}
            </Text>
          </Pressable>
          {download.isError ? (
            <Text style={styles.downloadError}>{String((download.error as Error).message)}</Text>
          ) : null}
          <View style={styles.panel}>
            {title ? <Text style={styles.panelTitle}>{title}</Text> : null}
            {tags.length > 0 ? (
              <View style={styles.tagRow}>
                {tags.map((tag) => (
                  <Text key={tag} style={styles.tag}>
                    {tag}
                  </Text>
                ))}
              </View>
            ) : null}
            {markdown ? (
              expanded ? (
                <ScrollView style={styles.expandedScroll}>
                  <Markdown markdown={markdown} preview />
                </ScrollView>
              ) : (
                <Text numberOfLines={2} style={styles.collapsedDescription}>
                  {markdown}
                </Text>
              )
            ) : null}
            {markdown ? (
              <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
                <Text style={styles.seeMore}>{expanded ? "See less" : "See more"}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  viewer: { backgroundColor: "rgba(0, 0, 0, 0.96)", flex: 1 },
  image: { height: "100%", width: "100%" },
  chrome: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  close: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    position: "absolute",
    right: spacing.md,
    top: spacing.xl + spacing.lg,
    width: 36,
  },
  closeText: { color: colors.text, fontSize: 16 },
  download: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    position: "absolute",
    right: spacing.md + 36 + spacing.sm,
    top: spacing.xl + spacing.lg,
    width: 36,
  },
  downloadError: {
    color: colors.danger,
    fontSize: 12,
    position: "absolute",
    right: spacing.md,
    textAlign: "right",
    top: spacing.xl + spacing.lg + 42,
  },
  panel: {
    backgroundColor: "rgba(10, 10, 10, 0.88)",
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    gap: spacing.xs,
    maxHeight: "55%",
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  tag: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    color: colors.textMuted,
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  panelTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  collapsedDescription: { color: colors.text, fontSize: 13, lineHeight: 18 },
  expandedScroll: { flexGrow: 0 },
  seeMore: { color: colors.accent, fontSize: 13, fontWeight: "600" },
});
