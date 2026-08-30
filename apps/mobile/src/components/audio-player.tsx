// Inline voice-note player for audio attachments (m4a/mp3/wav — anything the
// OS decoder speaks): play/pause, a Telegram-style scrubbable waveform
// (deterministic bars — lib/waveform.ts explains why they aren't spectral),
// and the clip length underneath. One fixed-height row at the bubble's full
// media width.
//
// Playback is expo-audio through the guarded loader; chat only renders this
// when audioPlayerAvailable() (old clients keep the plain file chip).

import { useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AgentUiFileAttachment } from "../lib/feed.ts";
import { formatClipDuration } from "../lib/composer-attachments.ts";
import { loadAudio } from "../lib/native-modules.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { WAVEFORM_BAR_COUNT, waveformBars } from "../lib/waveform.ts";

const AUDIO_ROW_HEIGHT = 56;

export function AudioMessagePlayer(props: { file: AgentUiFileAttachment; width: number }) {
  const audio = loadAudio()!;
  const player = audio.useAudioPlayer({ uri: props.file.url });
  const status = audio.useAudioPlayerStatus(player);
  const bars = waveformBars(props.file.filename, WAVEFORM_BAR_COUNT);

  // While a finger is on the waveform, IT owns the shown position; the seek
  // lands on release.
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);
  const waveRef = useRef<View>(null);
  const waveWindowX = useRef(0);
  const waveWidth = useRef(1);
  const durationRef = useRef(0);
  durationRef.current = status.duration;

  const setScrubBoth = (fraction: number) => {
    const clamped = Math.min(1, Math.max(0, fraction));
    scrubRef.current = clamped;
    setScrub(clamped);
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const pageX = event.nativeEvent.pageX;
        // Measured at touch time: the bubble lives in a scrolling list, so a
        // cached position would go stale.
        waveRef.current?.measureInWindow((x, _y, width) => {
          waveWindowX.current = x;
          waveWidth.current = width || 1;
          setScrubBoth((pageX - x) / waveWidth.current);
        });
      },
      onPanResponderMove: (_event, gesture) =>
        setScrubBoth((gesture.moveX - waveWindowX.current) / waveWidth.current),
      onPanResponderRelease: () => {
        const fraction = scrubRef.current;
        if (fraction !== null && durationRef.current > 0) {
          void player.seekTo(fraction * durationRef.current).then(() => {
            scrubRef.current = null;
            setScrub(null);
          });
        } else {
          scrubRef.current = null;
          setScrub(null);
        }
      },
      onPanResponderTerminate: () => {
        scrubRef.current = null;
        setScrub(null);
      },
    }),
  ).current;

  const togglePlay = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    // Voice notes play through the silent switch, like every messenger.
    void audio.setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      void player.seekTo(0);
    }
    player.play();
  };

  const progress =
    scrub !== null ? scrub : status.duration > 0 ? status.currentTime / status.duration : 0;

  return (
    <View style={[styles.row, { width: props.width }]}>
      <Pressable
        accessibilityLabel={status.playing ? "Pause audio" : "Play audio"}
        accessibilityRole="button"
        onPress={togglePlay}
        style={styles.playButton}
      >
        <Ionicons
          name={status.playing ? "pause" : "play"}
          size={18}
          color={colors.background}
          style={status.playing ? null : styles.playGlyphNudge}
        />
      </Pressable>
      <View style={styles.waveColumn}>
        <View
          {...pan.panHandlers}
          accessibilityLabel="Seek audio"
          collapsable={false}
          ref={waveRef}
          style={styles.wave}
        >
          {bars.map((bar, index) => (
            <View
              key={index}
              style={[
                styles.bar,
                {
                  height: Math.max(3, bar * 26),
                  backgroundColor:
                    index / bars.length <= progress ? colors.accent : colors.textFaint,
                },
              ]}
            />
          ))}
        </View>
        <Text style={styles.time}>
          {status.duration > 0
            ? `${formatClipDuration(scrub !== null ? scrub * status.duration : status.currentTime)} / ${formatClipDuration(status.duration)}`
            : "–:––"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: AUDIO_ROW_HEIGHT,
    minWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  // The play triangle reads centered only when nudged toward its point.
  playGlyphNudge: { transform: [{ translateX: 1 }] },
  waveColumn: { flex: 1, gap: 3 },
  wave: {
    height: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  bar: {
    flex: 1,
    borderRadius: 1,
  },
  time: { color: colors.textFaint, fontSize: 11, fontVariant: ["tabular-nums"] },
});
