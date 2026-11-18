import type { StrategyName } from '@sync-core/strategy';
import { useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { strings } from '@/strings';
import { APP_STRATEGIES, STRATEGY_LABELS } from '@/sync/strategies';
import { Palette } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import { Dialog, DialogButton } from '@/ui/components/Dialog';
import ErrorBanner from '@/ui/components/ErrorBanner';
import { fieldStyles } from '@/ui/components/fieldStyles';
import { useSubscriptions, useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { friendlyError, logError } from '@/util/log';

const SKEW_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '−1 h', seconds: -3600 },
  { label: '−1 min', seconds: -60 },
  { label: '0', seconds: 0 },
  { label: '+1 min', seconds: 60 },
  { label: '+1 h', seconds: 3600 },
];

/**
 * Hidden developer screen (long-press the list's title), used for the device experiments: choose the
 * strategy (wipes the local replica after a confirmation), add an artificial clock skew, force the
 * app offline, and export the sync metrics through the share sheet.
 */
export default function DeveloperSettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const viewModel = useSubscriptionViewModel();
  const { strategy, replicaId, settings } = useSubscriptions();
  const [pending, setPending] = useState<StrategyName | null>(null);
  const [skewText, setSkewText] = useState(String(settings.clockSkewSeconds));
  const [skewError, setSkewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (operation: string, task: () => Promise<unknown>) => {
    setError(null);
    try {
      await task();
    } catch (e) {
      logError(operation, e);
      setError(friendlyError(e));
    }
  };

  const applySkew = (seconds: number) => {
    setSkewText(String(seconds));
    setSkewError(null);
    void run('Set clock skew', () => viewModel.setClockSkew(seconds));
  };

  const applyTypedSkew = () => {
    const text = skewText.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      setSkewError(strings.devSkewInvalid);
      return;
    }
    applySkew(Number(text));
  };

  const exportMetrics = () =>
    run('Export metrics', async () => {
      const report = viewModel.metricsReport();
      await Share.share({ title: strings.devExportTitle, message: JSON.stringify(report, null, 2) });
    });

  return (
    <>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hint}>{strings.devIntro}</Text>
        <Text style={styles.mono} selectable>
          {strings.devReplica(strategy, replicaId ?? '–')}
        </Text>
        {error && (
          <View style={styles.error}>
            <ErrorBanner title={strings.errorDevSettings} reason={error} />
          </View>
        )}

        <Text style={[fieldStyles.label, styles.label]}>{strings.devStrategy}</Text>
        <View style={styles.card} accessibilityRole="radiogroup">
          {APP_STRATEGIES.map((s) => {
            const selected = s.name === strategy;
            return (
              <Pressable
                key={s.name}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => !selected && setPending(s.name)}
                style={styles.option}
              >
                <View style={[styles.radio, selected && styles.radioSelected]} />
                <Text style={styles.optionText}>{STRATEGY_LABELS[s.name]}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{strings.devStrategyHint}</Text>

        <Text style={[fieldStyles.label, styles.label]}>{strings.devClockSkew}</Text>
        <View style={styles.presets}>
          {SKEW_PRESETS.map((p) => (
            <Pressable
              key={p.label}
              onPress={() => applySkew(p.seconds)}
              accessibilityRole="button"
              style={[styles.preset, settings.clockSkewSeconds === p.seconds && styles.presetSelected]}
            >
              <Text style={styles.presetText}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.row}>
          <TextInput
            accessibilityLabel={strings.devClockSkew}
            value={skewText}
            onChangeText={(text) => {
              setSkewText(text);
              setSkewError(null);
            }}
            placeholder={strings.devSkewPlaceholder}
            placeholderTextColor={colors.textSecondary}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
            returnKeyType="done"
            onSubmitEditing={applyTypedSkew}
            style={[fieldStyles.input, styles.input, styles.flex, skewError ? { borderColor: colors.danger } : null]}
          />
          <Pressable onPress={applyTypedSkew} accessibilityRole="button" style={styles.textButton}>
            <Text style={styles.textButtonText}>{strings.devApply}</Text>
          </Pressable>
        </View>
        <Text style={[styles.hint, skewError ? { color: colors.danger } : null]}>
          {skewError ?? strings.devClockSkewHint(settings.clockSkewSeconds)}
        </Text>

        <View style={[styles.card, styles.switchRow]}>
          <View style={styles.flex}>
            <Text style={styles.optionText}>{strings.devForceOffline}</Text>
            <Text style={styles.hint}>{strings.devForceOfflineHint}</Text>
          </View>
          <Switch
            accessibilityLabel={strings.devForceOffline}
            value={settings.forceOffline}
            onValueChange={(value) => run('Force offline', () => viewModel.setForceOffline(value))}
            trackColor={{ true: colors.primary, false: colors.surfaceVariant }}
            thumbColor={Platform.OS === 'android' ? colors.surface : undefined}
          />
        </View>

        <Pressable
          onPress={exportMetrics}
          accessibilityRole="button"
          style={({ pressed }) => [styles.export, pressed && styles.pressed]}
        >
          <Text style={styles.exportText}>{strings.devExport}</Text>
        </Pressable>
        <Text style={styles.hint}>{strings.devExportHint}</Text>
      </ScrollView>

      <Modal visible={pending !== null} transparent animationType="fade" onRequestClose={() => setPending(null)}>
        {pending && (
          <Dialog
            title={strings.devSwitchTitle(STRATEGY_LABELS[pending])}
            onDismiss={() => setPending(null)}
            actions={
              <>
                <DialogButton label={strings.cancel} color={colors.primary} onPress={() => setPending(null)} />
                <DialogButton
                  label={strings.devSwitch}
                  color={colors.danger}
                  onPress={() => {
                    const next = pending;
                    setPending(null);
                    void run('Change strategy', () => viewModel.changeStrategy(next));
                  }}
                />
              </>
            }
          >
            <Text style={styles.dialogText}>{strings.devSwitchMessage}</Text>
          </Dialog>
        )}
      </Modal>
    </>
  );
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingHorizontal: 20, paddingTop: 8, width: '100%', maxWidth: 640, alignSelf: 'center' },
    label: { color: c.textSecondary, marginTop: 20 },
    hint: { fontSize: 13, color: c.textSecondary, marginTop: 6, lineHeight: 18 },
    mono: { fontSize: 12, color: c.textSecondary, marginTop: 6, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    error: { marginTop: 12 },
    card: { backgroundColor: c.surface, borderColor: c.cardStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12 },
    option: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.textSecondary, marginRight: 12 },
    radioSelected: { borderColor: c.primary, backgroundColor: c.primary },
    optionText: { fontSize: 16, color: c.textPrimary },
    presets: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
    preset: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: c.surfaceVariant,
      marginRight: 8,
      marginBottom: 8,
    },
    presetSelected: { backgroundColor: c.primaryContainer },
    presetText: { fontSize: 14, color: c.textPrimary },
    row: { flexDirection: 'row', alignItems: 'center' },
    input: { backgroundColor: c.surface, borderColor: c.cardStroke, color: c.textPrimary },
    textButton: { marginLeft: 8, paddingHorizontal: 14, paddingVertical: 12 },
    textButtonText: { fontSize: 15, fontWeight: '700', color: c.primary },
    switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, paddingVertical: 12 },
    export: {
      marginTop: 24,
      minHeight: 52,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 14,
      backgroundColor: c.primary,
    },
    pressed: { opacity: 0.85 },
    exportText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
    dialogText: { fontSize: 15, lineHeight: 22, color: c.textSecondary },
  });
