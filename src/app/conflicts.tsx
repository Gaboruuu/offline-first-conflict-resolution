import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { strings } from '@/strings';
import { Palette } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import ErrorBanner from '@/ui/components/ErrorBanner';
import { useSubscriptions, useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { ConflictView, describeConflict } from '@/util/conflicts';
import { friendlyError, logError } from '@/util/log';

/**
 * Conflict screen: every unresolved conflict of the local replica (S2 and S4 surface them), with its
 * candidates, e.g. "Price: 49.99 RON on this device, 54.99 RON on another device". Choosing one calls
 * `resolve`, a new write that wins over all candidates and is synced like any other change.
 */
export default function ConflictsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const viewModel = useSubscriptionViewModel();
  const { conflicts, subscriptions, replicaId } = useSubscriptions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const views = useMemo(() => {
    const byId = new Map(subscriptions.map((s) => [s.id, s]));
    return conflicts.map((c) => describeConflict(c, byId.get(c.recordId), replicaId));
  }, [conflicts, subscriptions, replicaId]);

  const choose = async (conflict: ConflictView, index: number) => {
    if (busy) return;
    setBusy(conflict.id);
    setError(null);
    try {
      await viewModel.resolveConflict(conflict.id, index);
    } catch (e) {
      logError('Resolve conflict', e);
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <FlatList
      data={views}
      keyExtractor={(c) => c.id}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      ListHeaderComponent={
        <View>
          {views.length > 0 && <Text style={styles.intro}>{strings.conflictIntro}</Text>}
          {error && (
            <View style={styles.error}>
              <ErrorBanner title={strings.errorResolve} reason={error} />
            </View>
          )}
        </View>
      }
      ListEmptyComponent={<Text style={styles.empty}>{strings.conflictNone}</Text>}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.title}>
            {item.title} · {item.field}
          </Text>
          {item.candidates.map((candidate, index) => (
            <View key={index} style={styles.candidate}>
              <View style={styles.flex}>
                <Text style={styles.value}>{candidate.value}</Text>
                <Text style={styles.origin}>{candidate.origin}</Text>
              </View>
              {busy === item.id ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Pressable
                  onPress={() => choose(item, index)}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`${strings.conflictKeep} ${strings.conflictChoice(candidate.value, candidate.origin)}`}
                  style={({ pressed }) => [styles.keep, pressed && styles.pressed]}
                >
                  <Text style={styles.keepText}>{strings.conflictKeep}</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
    />
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingHorizontal: 16, paddingTop: 8, flexGrow: 1, width: '100%', maxWidth: 640, alignSelf: 'center' },
    intro: { fontSize: 15, lineHeight: 22, color: c.textSecondary, marginBottom: 12 },
    error: { marginBottom: 12 },
    empty: { textAlign: 'center', color: c.textSecondary, fontSize: 16, marginTop: 64, lineHeight: 24 },
    card: {
      backgroundColor: c.surface,
      borderColor: c.cardStroke,
      borderWidth: 1,
      borderRadius: 16,
      padding: 14,
      marginBottom: 12,
    },
    title: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 6 },
    candidate: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.cardStroke,
    },
    value: { fontSize: 16, color: c.textPrimary },
    origin: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    keep: { marginLeft: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: c.primary },
    pressed: { opacity: 0.85 },
    keepText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
  });
