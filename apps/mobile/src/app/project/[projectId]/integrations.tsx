import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { BuiltinIntegrationSlug, OAuthProviderSlug } from "iterate/client";
import { ProjectDrawerButton } from "../../../components/project-drawer.tsx";
import {
  CONNECTABLE_INTEGRATIONS,
  listMobileIntegrations,
  PLATFORM_INTEGRATIONS,
  type MobileAccountConnection,
  type MobileIntegrationConnection,
  type MobileIntegrations,
} from "../../../lib/integrations.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { connectMobileOAuth } from "../../../lib/oauth-connect.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function IntegrationsScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const queryClient = useQueryClient();
  const queryKey = ["integrations", projectId];
  const integrations = useQuery({
    queryKey,
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      return await listMobileIntegrations(project);
    },
  });

  const connectOAuth = useMutation({
    mutationFn: async (provider: OAuthProviderSlug) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      const callbackUrl = Linking.createURL(`/project/${projectId}/integrations`, {
        queryParams: { slug: slug || "" },
      });
      const { authorizationUrl } = await project.integrations.startOAuthFlow({
        callbackUrl,
        provider,
      });
      const result = await connectMobileOAuth({
        authorizationUrl,
        callbackUrl,
        openAuthSession: WebBrowser.openAuthSessionAsync,
        project,
        provider,
      });
      return { project, ...result };
    },
    onSuccess: async ({ githubStealState, project }) => {
      if (githubStealState) {
        const move = await confirmAction(
          "Move this GitHub installation?",
          "It is connected to another project. Moving it disconnects that project and routes future GitHub activity here.",
          "Move installation",
        );
        if (move) await project.integrations.confirmGithubSteal({ state: githubStealState });
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const connectTelegram = useMutation({
    mutationFn: async (input: { botToken: string; steal: boolean }) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      return await project.integrations.connectTelegram({
        botToken: input.botToken,
        ...(input.steal ? { steal: true } : {}),
      });
    },
    onSuccess: async (result, input) => {
      if (!result.ok) {
        const move = await confirmAction(
          `Move ${result.botUsername ? `@${result.botUsername}` : "this Telegram bot"}?`,
          "It is connected to another project. The other project will lose the connection.",
          "Move bot",
        );
        if (move) connectTelegram.mutate({ botToken: input.botToken, steal: true });
        return;
      }
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const disconnect = useMutation({
    mutationFn: async (input: { connection: string; provider: BuiltinIntegrationSlug }) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      return await project.integrations.disconnect(input);
    },
    onSuccess: async () => await queryClient.invalidateQueries({ queryKey }),
  });

  const configureTelegramAccess = useMutation({
    mutationFn: async (connection: string) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      const access = await project.integrations.getTelegramAccess({ connection });
      const value = await promptForText(
        "Telegram user access",
        "Only these numeric Telegram user IDs can use project capabilities. Separate IDs with commas or new lines; leave empty to deny all.",
        access.allowedUserIds.join("\n"),
      );
      if (value === null) return null;
      const allowedUserIds = value.split(/[\s,]+/).filter(Boolean);
      await project.integrations.setTelegramAccess({ allowedUserIds, connection });
      return allowedUserIds;
    },
  });

  const connectAccount = useMutation({
    mutationFn: async () => {
      const account = await promptForAccountConnection();
      if (account === null) return null;
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      await project.secrets
        .get(`/secrets/integrations/${account.integration}/${account.connection}/session`)
        .create({
          egress: { urls: [new URL(account.loginUrl).origin] },
          material: { password: account.password, username: account.username },
          refresh: { graphqlUrl: account.loginUrl, kind: "waitrose-session" },
        });
      return account;
    },
    onSuccess: (account) => {
      if (account === null) return;
      queryClient.setQueryData<MobileIntegrations>(queryKey, (current) => {
        if (
          current === undefined ||
          current.accounts.some(
            (entry) =>
              entry.integration === account.integration && entry.connection === account.connection,
          )
        ) {
          return current;
        }
        return {
          ...current,
          accounts: [
            ...current.accounts,
            {
              connected: account.integration === "waitrose" ? true : null,
              connection: account.connection,
              integration: account.integration,
              path: `/secrets/integrations/${account.integration}/${account.connection}/session`,
            },
          ],
        };
      });
    },
  });

  const mutationError =
    connectOAuth.error ||
    connectTelegram.error ||
    disconnect.error ||
    configureTelegramAccess.error ||
    connectAccount.error;
  const pendingProvider = connectOAuth.isPending ? connectOAuth.variables : null;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: "Integrations",
          headerLeft: () => (
            <ProjectDrawerButton projectId={projectId} projectSlug={slug || "Integrations"} />
          ),
        }}
      />
      {integrations.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : integrations.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{integrations.error.message}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => integrations.refetch()}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              onRefresh={() => integrations.refetch()}
              refreshing={integrations.isRefetching}
              tintColor={colors.textMuted}
            />
          }
        >
          <Text style={styles.intro}>
            Connections are project-scoped. Credentials stay server-side and each connection keeps
            its own integration journal.
          </Text>
          {mutationError ? <Text style={styles.errorBanner}>{mutationError.message}</Text> : null}

          <Section title="Connectable integrations">
            {CONNECTABLE_INTEGRATIONS.map((integration) => (
              <IntegrationCard
                key={integration.key}
                integration={integration}
                connections={integrations.data.connections[integration.key]}
                connecting={
                  integration.provider === "telegram"
                    ? connectTelegram.isPending
                    : pendingProvider === integration.provider
                }
                disconnecting={disconnect.isPending}
                onConnect={async () => {
                  if (integration.provider === "telegram") {
                    const botToken = await promptForText(
                      "Connect a Telegram bot",
                      "Create the bot with @BotFather, then paste its token. It is stored write-only.",
                      "",
                      true,
                    );
                    if (botToken) connectTelegram.mutate({ botToken, steal: false });
                    return;
                  }
                  connectOAuth.mutate(integration.provider);
                }}
                onConfigureAccess={(connection) => configureTelegramAccess.mutate(connection)}
                onDisconnect={async (connection) => {
                  const confirmed = await confirmAction(
                    `Disconnect ${connection}?`,
                    `${integration.name} calls and incoming events will stop working for this project.`,
                    "Disconnect",
                  );
                  if (confirmed) {
                    disconnect.mutate({ connection, provider: integration.provider });
                  }
                }}
              />
            ))}
            <AccountConnectionsCard
              accounts={integrations.data.accounts}
              connecting={connectAccount.isPending}
              disconnecting={disconnect.isPending}
              onConnect={() => connectAccount.mutate()}
              onDisconnect={async (account) => {
                const confirmed = await confirmAction(
                  `Disconnect ${account.connection}?`,
                  "This account's stored session credential will stop working for this project.",
                  "Disconnect",
                );
                if (confirmed) {
                  disconnect.mutate({ connection: account.connection, provider: "waitrose" });
                }
              }}
            />
          </Section>

          {integrations.data.provided.length > 0 ? (
            <Section title="Project integrations">
              <Text style={styles.sectionDescription}>
                Mounted by this project through provideCapability; manage these in project code.
              </Text>
              {integrations.data.provided.map((entry) => (
                <View key={entry.path} style={styles.card}>
                  <Text style={styles.cardTitle}>{entry.integration}</Text>
                  <Text style={styles.description}>
                    {entry.connection === null
                      ? "Integration-level mount provided by project code."
                      : `Connection ${entry.connection} provided by project code.`}
                  </Text>
                  <Text selectable style={styles.namespace}>
                    {entry.path}
                  </Text>
                </View>
              ))}
            </Section>
          ) : null}

          <Section title="Built-in integrations">
            <Text style={styles.sectionDescription}>
              Iterate-managed capabilities work without creating a connection. Usage is charged to
              this project.
            </Text>
            {PLATFORM_INTEGRATIONS.map((integration) => (
              <View key={integration.namespace} style={styles.card}>
                <Text style={styles.cardTitle}>{integration.name}</Text>
                <Text selectable style={styles.namespace}>
                  {integration.namespace}
                </Text>
                <Text style={styles.description}>{integration.description}</Text>
              </View>
            ))}
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function IntegrationCard({
  connecting,
  connections,
  disconnecting,
  integration,
  onConfigureAccess,
  onConnect,
  onDisconnect,
}: {
  connecting: boolean;
  connections: MobileIntegrationConnection[];
  disconnecting: boolean;
  integration: (typeof CONNECTABLE_INTEGRATIONS)[number];
  onConfigureAccess: (connection: string) => void;
  onConnect: () => void;
  onDisconnect: (connection: string) => void;
}) {
  const connected = connections.filter((connection) => connection.status.connected).length;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardCopy}>
          <Text style={styles.cardTitle}>{integration.name}</Text>
          <Text style={styles.description}>{integration.description}</Text>
          <Text style={styles.summary}>
            {connected === 0 ? "Not connected" : `${connected} connected`}
          </Text>
        </View>
        <ActionButton
          disabled={connecting}
          label={connecting ? "Connecting…" : "Connect"}
          onPress={onConnect}
        />
      </View>
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.path}
          connection={connection}
          disconnecting={disconnecting}
          onConfigureAccess={
            integration.provider === "telegram" && connection.status.connected
              ? () => onConfigureAccess(connection.connection)
              : null
          }
          onDisconnect={() => onDisconnect(connection.connection)}
        />
      ))}
    </View>
  );
}

function AccountConnectionsCard({
  accounts,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
}: {
  accounts: MobileAccountConnection[];
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: (account: MobileAccountConnection) => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardCopy}>
          <Text style={styles.cardTitle}>Account connections</Text>
          <Text style={styles.description}>
            Username/password accounts for providers without OAuth. Credentials are stored
            write-only and re-login when their session expires.
          </Text>
        </View>
        <ActionButton
          disabled={connecting}
          label={connecting ? "Connecting…" : "Connect"}
          onPress={onConnect}
        />
      </View>
      {accounts.map((account) => (
        <View key={account.path} style={styles.connection}>
          <View style={styles.connectionCopy}>
            <Text numberOfLines={1} style={styles.connectionName}>
              {account.integration} / {account.connection}
            </Text>
            <Text numberOfLines={1} style={styles.path}>
              itx.worker.{account.integration}.{account.connection}
            </Text>
            {account.connected === null ? null : (
              <Text style={account.connected ? styles.connected : styles.disconnected}>
                {account.connected ? "Connected" : "Disconnected"}
              </Text>
            )}
          </View>
          {account.integration === "waitrose" && account.connected ? (
            <ActionButton
              disabled={disconnecting}
              label="Disconnect"
              onPress={() => onDisconnect(account)}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ConnectionRow({
  connection,
  disconnecting,
  onConfigureAccess,
  onDisconnect,
}: {
  connection: MobileIntegrationConnection;
  disconnecting: boolean;
  onConfigureAccess: (() => void) | null;
  onDisconnect: () => void;
}) {
  return (
    <View style={styles.connection}>
      <View style={styles.connectionCopy}>
        <Text numberOfLines={1} style={styles.connectionName}>
          {connection.connection}
        </Text>
        <Text numberOfLines={1} style={styles.path}>
          {connection.path}
        </Text>
        <Text style={connection.status.connected ? styles.connected : styles.disconnected}>
          {connection.status.connected ? "Connected" : "Disconnected"}
          {connection.status.displayName ? ` · ${connection.status.displayName}` : ""}
        </Text>
        {connection.status.externalId ? (
          <Text numberOfLines={1} style={styles.externalId}>
            ID {connection.status.externalId}
          </Text>
        ) : null}
      </View>
      {onConfigureAccess ? <ActionButton label="Access" onPress={onConfigureAccess} /> : null}
      {connection.status.connected ? (
        <ActionButton disabled={disconnecting} label="Disconnect" onPress={onDisconnect} />
      ) : null}
    </View>
  );
}

function ActionButton({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.actionDisabled]}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

async function promptForAccountConnection() {
  const integration = await promptForText(
    "Integration",
    "Lowercase name for the account provider.",
    "waitrose",
  );
  if (integration === null) return null;
  const connection = await promptForText(
    "Connection name",
    "Your name for this account, such as personal or mum.",
    "",
  );
  if (connection === null) return null;
  const username = await promptForText("Username / email", "The provider login.", "");
  if (username === null) return null;
  const password = await promptForText("Password", "Stored write-only.", "", true);
  if (password === null) return null;
  const loginUrl = await promptForText(
    "Login URL",
    "The provider session-login endpoint. Egress is pinned to its origin.",
    "https://www.waitrose.com/api/graphql-prod/graph/live",
  );
  if (loginUrl === null) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(integration) || !/^[a-z][a-z0-9-]*$/.test(connection)) {
    throw new Error("Integration and connection names need lowercase letters, digits, and dashes.");
  }
  new URL(loginUrl);
  return { connection, integration, loginUrl, password, username };
}

function promptForText(
  title: string,
  message: string,
  defaultValue: string,
  secure = false,
): Promise<string | null> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.prompt(`${title}\n\n${message}`, defaultValue));
  }
  return new Promise((resolve) => {
    Alert.prompt(
      title,
      message,
      [
        { onPress: () => resolve(null), style: "cancel", text: "Cancel" },
        { onPress: (value?: string) => resolve(value || ""), text: "Continue" },
      ],
      secure ? "secure-text" : "plain-text",
      defaultValue,
    );
  });
}

function confirmAction(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { onPress: () => resolve(false), style: "cancel", text: "Cancel" },
      { onPress: () => resolve(true), style: "destructive", text: confirmLabel },
    ]);
  });
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  center: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.lg,
  },
  content: { gap: spacing.xl, padding: spacing.md, paddingBottom: 48 },
  intro: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  sectionDescription: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  cardHeader: { alignItems: "flex-start", flexDirection: "row", gap: spacing.sm },
  cardCopy: { flex: 1, gap: spacing.xs },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  summary: { color: colors.textFaint, fontSize: 11 },
  namespace: {
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    color: colors.textMuted,
    fontFamily: "Menlo",
    fontSize: 10,
    overflow: "hidden",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  connection: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  connectionCopy: { flex: 1, gap: 2 },
  connectionName: { color: colors.text, fontSize: 13, fontWeight: "600" },
  path: { color: colors.textFaint, fontFamily: "Menlo", fontSize: 9 },
  connected: { color: colors.accent, fontSize: 11 },
  disconnected: { color: colors.textMuted, fontSize: 11 },
  externalId: { color: colors.textMuted, fontSize: 10 },
  action: {
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
  },
  actionDisabled: { opacity: 0.45 },
  actionText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  errorBanner: {
    backgroundColor: "#2a1318",
    borderColor: colors.danger,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.danger,
    fontSize: 12,
    padding: spacing.sm,
  },
  retry: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
});
