import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Connection } from '@/data/SyncRepository';
import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';
import { formatSyncTime } from '@/util/dates';

interface Props {
  connection: Connection;
  syncing: boolean;
  lastSyncedAt: string | null;
  hasUnsentChanges: boolean;
  onRetry: () => void;
}

/**
 * Connection state above the list: an offline banner (with a Retry button), "Syncing…" during a
 * sync session, then when the last session finished and whether local changes still wait to be sent.
 */
export default function SyncStatus({ connection, syncing, lastSyncedAt, hasUnsentChanges, onRetry }: Props) {
  const { colors } = useTheme();
  const offline = connection === 'offline';
  const lastSynced = lastSyncedAt
    ? strings.lastSynced(formatSyncTime(lastSyncedAt, { today: strings.today, yesterday: strings.yesterday }))
    : strings.neverSynced;
  const details = [lastSynced, hasUnsentChanges ? strings.unsentChanges : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.box,
        offline
          ? { backgroundColor: colors.surface, borderColor: colors.dueSoon }
          : { backgroundColor: 'transparent', borderColor: 'transparent' },
      ]}
    >
      <View style={styles.text}>
        {offline && <Text style={[styles.title, { color: colors.textPrimary }]}>{strings.offlineBanner}</Text>}
        <Text style={[styles.details, { color: colors.textSecondary }]} numberOfLines={2}>
          {connection === 'connecting' ? strings.connecting : syncing ? strings.syncing : details}
        </Text>
      </View>
      {syncing || connection === 'connecting' ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        offline && (
          <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8} style={styles.retry}>
            <Text style={[styles.retryText, { color: colors.primary }]}>{strings.retry}</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: { flex: 1 },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  details: { fontSize: 13 },
  retry: { marginLeft: 12, paddingHorizontal: 8, paddingVertical: 4 },
  retryText: { fontSize: 15, fontWeight: '700' },
});
