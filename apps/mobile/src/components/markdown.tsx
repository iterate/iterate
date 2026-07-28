import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";
import { Linking, StyleSheet, View } from "react-native";
import { colors, radius, spacing } from "../lib/theme.ts";

export function Markdown({ markdown, preview = false }: { markdown: string; preview?: boolean }) {
  return (
    <View style={preview ? styles.preview : styles.message}>
      <EnrichedMarkdownText
        flavor="github"
        markdown={markdown}
        markdownStyle={markdownStyle}
        md4cFlags={{ latexMath: false, underline: false }}
        onLinkPress={({ url }) => void Linking.openURL(url)}
        selectable
        streamingAnimation={!preview}
      />
    </View>
  );
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

const styles = StyleSheet.create({
  message: { width: "100%" },
  preview: { padding: spacing.md },
});
