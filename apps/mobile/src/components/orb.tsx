import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { colors } from "../lib/theme.ts";

export type OrbState = "idle" | "connecting" | "listening" | "speaking" | "thinking" | "ended";

const ORB_SIZE = 168;

const STATE_COLOR: Record<OrbState, string> = {
  idle: colors.idle,
  ended: colors.idle,
  connecting: colors.connecting,
  listening: colors.listening,
  speaking: colors.speaking,
  thinking: colors.thinking,
};

/**
 * The presence indicator: a soft disc that breathes while listening, swells
 * while the assistant speaks, shimmers while the worker thinks, and sits
 * still otherwise. Plain reanimated pulse/scale/glow — deliberately no
 * shader art.
 */
export function Orb({ state }: { state: OrbState }) {
  const coreStyle = useAnimatedStyle(() => {
    const animation =
      state === "speaking"
        ? withRepeat(
            withSequence(
              withTiming(1.12, { duration: 320, easing: Easing.inOut(Easing.quad) }),
              withTiming(0.98, { duration: 380, easing: Easing.inOut(Easing.quad) }),
            ),
            -1,
            true,
          )
        : state === "listening"
          ? withRepeat(
              withSequence(
                withTiming(1.05, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
                withTiming(0.97, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
              ),
              -1,
              true,
            )
          : state === "connecting" || state === "thinking"
            ? withRepeat(
                withSequence(
                  withTiming(1.02, { duration: 700, easing: Easing.inOut(Easing.quad) }),
                  withTiming(0.99, { duration: 700, easing: Easing.inOut(Easing.quad) }),
                ),
                -1,
                true,
              )
            : withTiming(1, { duration: 400 });
    return { transform: [{ scale: animation }] };
  }, [state]);

  const haloStyle = useAnimatedStyle(() => {
    const active = state === "speaking" || state === "listening" || state === "thinking";
    return {
      opacity: active
        ? withRepeat(
            withSequence(
              withTiming(0.35, { duration: state === "speaking" ? 400 : 1400 }),
              withTiming(0.12, { duration: state === "speaking" ? 500 : 1400 }),
            ),
            -1,
            true,
          )
        : withTiming(state === "connecting" ? 0.15 : 0.05, { duration: 400 }),
      transform: [
        {
          scale:
            active || state === "connecting"
              ? withRepeat(
                  withSequence(
                    withTiming(1.35, { duration: state === "speaking" ? 450 : 1500 }),
                    withTiming(1.15, { duration: state === "speaking" ? 450 : 1500 }),
                  ),
                  -1,
                  true,
                )
              : withTiming(1.1, { duration: 400 }),
        },
      ],
    };
  }, [state]);

  const color = STATE_COLOR[state];
  return (
    <View style={styles.container}>
      <Animated.View style={[styles.halo, { backgroundColor: color }, haloStyle]} />
      <Animated.View
        style={[styles.core, { backgroundColor: color, shadowColor: color }, coreStyle]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: ORB_SIZE * 1.6,
    height: ORB_SIZE * 1.6,
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
  },
  core: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: ORB_SIZE / 2,
    opacity: 0.9,
    shadowOpacity: 0.6,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 },
  },
});
