import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { createURL } from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { resolveInAppLink } from "../lib/in-app-links.ts";
import { openMiniPage, resolveMiniPageUrl } from "../lib/mini-page.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function Markdown({ markdown, preview = false }: { markdown: string; preview?: boolean }) {
  // Same-deployment special links (/media/..., /repos/...) open the rich
  // in-app screen; everything else goes to the system browser. Rendered
  // inside a project route this knows the project; outside one, projectId is
  // undefined and the resolver declines.
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  return (
    <View style={preview ? styles.preview : styles.message}>
      <EnrichedMarkdownText
        flavor="github"
        markdown={markdown}
        markdownStyle={preview ? previewMarkdownStyle : markdownStyle}
        md4cFlags={{ latexMath: false, underline: false }}
        onLinkPress={({ url }) => {
          const inApp = resolveInAppLink(url, { baseUrl: server.data, projectId });
          if (inApp) {
            router.push(inApp);
            return;
          }
          const miniPage = resolveMiniPageUrl(url, { baseUrl: server.data });
          if (miniPage) {
            void openMiniPageFromChat(miniPage);
            return;
          }
          void Linking.openURL(url);
        }}
        selectable
        streamingAnimation={!preview}
      />
    </View>
  );
}

/**
 * A one-job OS page (right now: "provide a secret") opened in an in-app
 * browser sheet that closes itself when the page is done — the user never
 * leaves the thread. See lib/mini-page.ts for the contract.
 *
 * Success needs no confirmation of its own: the page tells the agent, and the
 * agent's reply streams into the thread the user is already looking at. The
 * one case that does is a stored secret whose agent could not be told, which
 * only the user can now unstick.
 */
async function openMiniPageFromChat(url: string) {
  const outcome = await openMiniPage({
    openAuthSession: WebBrowser.openAuthSessionAsync,
    returnUrl: createURL("mini-page"),
    url,
  });
  if (outcome.kind === "done" && outcome.status === "notify-failed") {
    Alert.alert(
      "Saved, but the agent wasn't told",
      `The secret at ${outcome.params.path} is stored. Send a message saying it's ready.`,
    );
  }
}

const markdownStyle: MarkdownStyle = {
  paragraph: { color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: spacing.sm },
  h1: { color: colors.text, fontSize: 25, lineHeight: 31, marginBottom: 12, marginTop: 4 },
  h2: { color: colors.text, fontSize: 21, lineHeight: 27, marginBottom: 10, marginTop: 10 },
  h3: { color: colors.text, fontSize: 18, lineHeight: 24, marginBottom: 8, marginTop: 8 },
  h4: { color: colors.text, fontSize: 16, lineHeight: 22, marginBottom: 6, marginTop: 6 },
  h5: { color: colors.textMuted, fontSize: 15, lineHeight: 21, marginBottom: 6, marginTop: 6 },
  h6: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 6, marginTop: 6 },
  blockquote: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.textFaint,
    borderWidth: 3,
    color: colors.textMuted,
    gapWidth: 10,
    marginBottom: spacing.sm,
  },
  list: {
    bulletColor: colors.textMuted,
    color: colors.text,
    fontSize: 15,
    gapWidth: 8,
    lineHeight: 22,
    marginBottom: spacing.sm,
    markerColor: colors.textMuted,
  },
  codeBlock: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.sm,
    padding: 12,
  },
  code: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    color: colors.text,
    fontFamily: "Menlo",
    fontSize: 13,
  },
  link: { color: colors.accent, underline: true },
  strong: { color: colors.text },
  table: {
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    fontSize: 14,
    headerBackgroundColor: colors.surfaceRaised,
    headerTextColor: colors.text,
    rowEvenBackgroundColor: colors.background,
    rowOddBackgroundColor: colors.surface,
  },
  taskList: { borderColor: colors.textMuted, checkedColor: colors.accent },
  thematicBreak: { color: colors.border, height: 1, marginBottom: 12, marginTop: 12 },
};

// Preview contexts (media rows, viewer chrome): toMarkdown loves to open
// with "# Screenshot Overview" — huge heading text reads absurd in a list
// row, so headings collapse to bold body-sized text.
const previewMarkdownStyle: MarkdownStyle = {
  ...markdownStyle,
  h1: { color: colors.text, fontSize: 14, lineHeight: 19, marginBottom: 4, marginTop: 2 },
  h2: { color: colors.text, fontSize: 14, lineHeight: 19, marginBottom: 4, marginTop: 4 },
  h3: { color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 4, marginTop: 4 },
  h4: { color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 4, marginTop: 4 },
  h5: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 4, marginTop: 4 },
  h6: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 4, marginTop: 4 },
  paragraph: { color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 6 },
};

const styles = StyleSheet.create({
  message: { width: "100%" },
  preview: { padding: spacing.md },
});
