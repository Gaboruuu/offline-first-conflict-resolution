import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Subscription } from '@/model/Subscription';
import { strings } from '@/strings';
import { Palette } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import ConflictBanner from '@/ui/components/ConflictBanner';
import ErrorBanner from '@/ui/components/ErrorBanner';
import Snackbar from '@/ui/components/Snackbar';
import SubscriptionItem from '@/ui/components/SubscriptionItem';
import SyncStatus from '@/ui/components/SyncStatus';
import ThemeDialog from '@/ui/components/ThemeDialog';
import { SubscriptionEvent, useSubscriptions, useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { friendlyError, logError } from '@/util/log';
import { useNavigateFrom } from '@/util/navigation';
import { formatMoney } from '@/util/money';

const keyExtractor = (item: Subscription) => item.id;

function eventMessage({ type, name, offline, remote }: SubscriptionEvent): string {
  if (remote) {
    return type === 'created' ? strings.eventRemoteCreated(name)
      : type === 'updated' ? strings.eventRemoteUpdated(name)
        : strings.eventRemoteDeleted(name);
  }
  const message = type === 'created' ? strings.eventCreated(name)
    : type === 'updated' ? strings.eventUpdated(name)
      : strings.eventDeleted(name);
  return offline ? strings.eventOffline(message) : message;
}

/**
 * Read screen: the list of subscriptions and the monthly total. The screen and its FlatList
 * stay mounted for the whole session; they only receive the repository's new snapshot.
 * The rows are the local replica's records, opened once in the background; the repository then
 * syncs the replica with the server whenever something changes. The sync state is shown above the list; a failed
 * read or sync is logged and shown here with a Retry button.
 */
export default function SubscriptionListScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const viewModel = useSubscriptionViewModel();
  const {
    status, error, subscriptions, monthlyTotal, activeCount,
    connection, syncing, lastSyncedAt, syncError, hasUnsentChanges, conflicts,
  } = useSubscriptions();
  const navigateFrom = useNavigateFrom();

  const [themeDialogVisible, setThemeDialogVisible] = useState(false);
  const [snackbar, setSnackbar] = useState<{ text: string; key: number } | null>(null);

  const load = useCallback(() => {
    viewModel.load().catch((e) => logError('Load subscriptions', e));
  }, [viewModel]);
  useEffect(load, [load]);
  const retrySync = useCallback(() => {
    viewModel.retrySync().catch((e) => logError('Retry sync', e));
  }, [viewModel]);

  useEffect(
    () => viewModel.onEvent((event) => setSnackbar({ text: eventMessage(event), key: Date.now() })),
    [viewModel],
  );
  const hideSnackbar = useCallback(() => setSnackbar(null), []);

  // Stable callbacks, so memoised rows are not re-rendered when the list changes.
  const openUpdate = useCallback(
    (id: string) => navigateFrom({ pathname: '/update/[id]', params: { id } }),
    [navigateFrom],
  );
  const openDelete = useCallback(
    (id: string) => navigateFrom({ pathname: '/delete/[id]', params: { id } }),
    [navigateFrom],
  );
  const conflictedIds = useMemo(() => new Set(conflicts.map((c) => c.recordId)), [conflicts]);
  const renderItem = useCallback(
    ({ item }: { item: Subscription }) => (
      <SubscriptionItem
        item={item}
        hasConflict={conflictedIds.has(item.id)}
        onPress={openUpdate}
        onSwipeDelete={openDelete}
      />
    ),
    [openUpdate, openDelete, conflictedIds],
  );

  const fabBottom = insets.bottom + 20;

  return (
    <View style={[styles.root, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[styles.toolbar, { paddingTop: insets.top }]}>
        <Text style={styles.title} accessibilityRole="header">
          {strings.appName}
        </Text>
        <Pressable
          onPress={() => setThemeDialogVisible(true)}
          accessibilityRole="button"
          accessibilityLabel={strings.actionTheme}
          hitSlop={8}
          style={({ pressed }) => [styles.themeButton, pressed && { backgroundColor: colors.surfaceVariant }]}
        >
          <Text style={styles.themeIcon}>◐</Text>
        </Pressable>
      </View>

      {/* Compact monthly total summary */}
      <LinearGradient
        colors={[colors.summaryStart, colors.summaryEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.summary}
      >
        <View style={styles.summaryText}>
          <Text style={styles.totalLabel}>{strings.monthlyTotal}</Text>
          <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit>
            {formatMoney(monthlyTotal, 'RON')}
          </Text>
        </View>
        <Text style={styles.pill}>{strings.activeSubscriptions(activeCount, subscriptions.length)}</Text>
      </LinearGradient>

      {status === 'ready' && (
        <SyncStatus
          connection={connection}
          syncing={syncing}
          lastSyncedAt={lastSyncedAt}
          hasUnsentChanges={hasUnsentChanges}
          onRetry={retrySync}
        />
      )}

      {status === 'ready' && (
        <ConflictBanner count={conflicts.length} onPress={() => navigateFrom('/conflicts')} />
      )}

      {status === 'error' && (
        <View style={styles.error}>
          <ErrorBanner title={strings.errorLoad} reason={friendlyError(error)} onRetry={load} />
        </View>
      )}
      {status === 'ready' && syncError !== undefined && !syncing && (
        <View style={styles.error}>
          <ErrorBanner title={strings.errorSync} reason={friendlyError(syncError)} onRetry={retrySync} />
        </View>
      )}

      <FlatList
        data={subscriptions}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: fabBottom + 76 }]}
        ListEmptyComponent={
          status === 'ready' ? (
            <Text style={styles.empty}>{strings.emptyState}</Text>
          ) : status === 'error' ? null : (
            <View style={styles.loading} accessibilityLabel={strings.loading}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          )
        }
      />

      <Snackbar message={snackbar} bottom={fabBottom + 72} onHidden={hideSnackbar} />

      {/* Hidden until the list is loaded, so a new element can never be overwritten by the first read. */}
      {status === 'ready' && (
        <Pressable
          onPress={() => navigateFrom('/create')}
          accessibilityRole="button"
          accessibilityLabel={strings.addSubscription}
          style={({ pressed }) => [styles.fab, { bottom: fabBottom, right: 20 + insets.right }, pressed && styles.fabPressed]}
        >
          <Text style={styles.fabIcon}>+</Text>
        </Pressable>
      )}

      <ThemeDialog visible={themeDialogVisible} onClose={() => setThemeDialogVisible(false)} />
    </View>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.background },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 56,
      paddingLeft: 16,
      paddingRight: 8,
      backgroundColor: c.background,
    },
    title: { fontSize: 22, fontWeight: '700', color: c.textPrimary, paddingVertical: 14 },
    themeButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    themeIcon: { fontSize: 22, color: c.textPrimary },
    summary: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 4,
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingVertical: 14,
      elevation: 2,
    },
    summaryText: { flex: 1, marginRight: 12 },
    totalLabel: { fontSize: 14, fontWeight: '500', color: c.summaryTextMuted },
    total: { fontSize: 24, fontWeight: '700', color: c.summaryText, marginTop: 2 },
    pill: {
      backgroundColor: c.summaryPill,
      color: c.summaryText,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      overflow: 'hidden',
      fontSize: 13,
      fontWeight: '500',
    },
    listContent: { paddingHorizontal: 16, paddingTop: 14, flexGrow: 1 },
    error: { marginHorizontal: 16, marginTop: 14 },
    loading: { marginTop: 64, alignItems: 'center' },
    empty: { textAlign: 'center', color: c.textSecondary, fontSize: 16, marginTop: 64, lineHeight: 24 },
    fab: {
      position: 'absolute',
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
    },
    fabPressed: { opacity: 0.85 },
    fabIcon: { fontSize: 32, lineHeight: 34, color: c.onPrimary, fontWeight: '400' },
  });
