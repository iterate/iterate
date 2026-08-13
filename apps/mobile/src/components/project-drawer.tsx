import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import {
  Animated,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing } from "../lib/theme.ts";

type ProjectDrawerProps = {
  projectId: string;
  projectSlug: string;
};

export function ProjectDrawerButton({ projectId, projectSlug }: ProjectDrawerProps) {
  return <DrawerButton project={{ projectId, projectSlug }} />;
}

/** The same drawer outside any project — signed-out screens included. Build
 * info must be reachable from EVERYWHERE (it names the running channel and
 * commit, the first thing to check when a preview looks wrong). */
export function AppDrawerButton() {
  return <DrawerButton project={null} />;
}

function DrawerButton({ project }: { project: { projectId: string; projectSlug: string } | null }) {
  const queryClient = useQueryClient();
  const drawerKey = ["project-drawer", !project ? "app" : project.projectId];
  const drawer = useQuery({
    queryKey: drawerKey,
    queryFn: async () => false,
    initialData: false,
    staleTime: Infinity,
  });
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const drawerWidth = Math.min(width * 0.82, 340);
  const translateX = useRef(new Animated.Value(-drawerWidth)).current;

  const open = () => {
    translateX.setValue(-drawerWidth);
    queryClient.setQueryData(drawerKey, true);
    requestAnimationFrame(() => {
      Animated.timing(translateX, {
        duration: 180,
        toValue: 0,
        useNativeDriver: true,
      }).start();
    });
  };
  const close = (navigate?: () => void) => {
    Animated.timing(translateX, {
      duration: 150,
      toValue: -drawerWidth,
      useNativeDriver: true,
    }).start(() => {
      queryClient.setQueryData(drawerKey, false);
      navigate?.();
    });
  };
  const projectRoute =
    (
      pathname:
        | "/project/[projectId]"
        | "/project/[projectId]/repos"
        | "/project/[projectId]/integrations"
        | "/project/[projectId]/media"
        | "/project/[projectId]/notes"
        | "/project/[projectId]/notifications",
    ) =>
    () => {
      // Only rendered inside the project !== null branch below; the guard is
      // for the type system, not a reachable path.
      if (!project) return;
      router.push({
        pathname,
        params: { projectId: project.projectId, slug: project.projectSlug },
      });
    };

  return (
    <>
      <Pressable
        accessibilityLabel="Open project menu"
        accessibilityRole="button"
        hitSlop={12}
        onPress={open}
        style={styles.menuButton}
      >
        <Text style={styles.menuGlyph}>☰</Text>
      </Pressable>
      <Modal
        animationType="none"
        onRequestClose={() => close()}
        statusBarTranslucent
        transparent
        visible={drawer.data}
      >
        <View style={styles.modal}>
          <Pressable
            accessibilityLabel="Close project menu"
            onPress={() => close()}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View
            style={[styles.drawer, { width: drawerWidth, transform: [{ translateX }] }]}
          >
            <View
              style={[
                styles.safeArea,
                {
                  paddingBottom: insets.bottom + spacing.lg,
                  paddingLeft: insets.left + spacing.lg,
                  paddingRight: insets.right + spacing.lg,
                  paddingTop: insets.top + spacing.lg,
                },
              ]}
            >
              <View style={styles.brand}>
                <Image source={require("../../assets/images/icon.png")} style={styles.logo} />
                <View style={styles.brandCopy}>
                  <Text style={styles.brandName}>Iterate</Text>
                  {project ? (
                    <Text numberOfLines={1} style={styles.projectSlug}>
                      {project.projectSlug}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityLabel="Close project menu"
                  accessibilityRole="button"
                  hitSlop={12}
                  onPress={() => close()}
                >
                  <Text style={styles.close}>×</Text>
                </Pressable>
              </View>

              <View style={styles.items}>
                {project ? (
                  <>
                    <DrawerItem
                      label="/agents"
                      onPress={() => close(projectRoute("/project/[projectId]"))}
                    />
                    <DrawerItem
                      label="/integrations"
                      onPress={() => close(projectRoute("/project/[projectId]/integrations"))}
                    />
                    <DrawerItem
                      label="/repos"
                      onPress={() => close(projectRoute("/project/[projectId]/repos"))}
                    />
                    <DrawerItem
                      label="/media"
                      onPress={() => close(projectRoute("/project/[projectId]/media"))}
                    />
                    <DrawerItem
                      label="/notes"
                      onPress={() => close(projectRoute("/project/[projectId]/notes"))}
                    />
                    <DrawerItem
                      label="/notifications"
                      onPress={() => close(projectRoute("/project/[projectId]/notifications"))}
                    />
                    <View style={styles.separator} />
                    <DrawerItem
                      label="Switch project"
                      onPress={() => close(() => router.push("/projects"))}
                    />
                  </>
                ) : null}
                <DrawerItem
                  label="Build info"
                  onPress={() => close(() => router.push("/build-info"))}
                />
              </View>
            </View>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

function DrawerItem({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.item}>
      <Text style={styles.itemLabel}>{label}</Text>
      <Text style={styles.itemChevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  menuButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  menuGlyph: { color: colors.text, fontSize: 20, lineHeight: 22 },
  modal: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.58)" },
  drawer: {
    backgroundColor: colors.background,
    borderRightColor: colors.border,
    borderRightWidth: 1,
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  safeArea: { flex: 1 },
  brand: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  logo: { borderRadius: radius.sm, height: 42, width: 42 },
  brandCopy: { flex: 1 },
  brandName: { color: colors.text, fontSize: 18, fontWeight: "700" },
  projectSlug: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  close: { color: colors.textMuted, fontSize: 30, fontWeight: "300" },
  items: { gap: spacing.xs, marginTop: spacing.xl },
  item: {
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  itemLabel: { color: colors.text, fontSize: 16, fontWeight: "500" },
  itemChevron: { color: colors.textFaint, fontSize: 24 },
  separator: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.sm,
  },
});
