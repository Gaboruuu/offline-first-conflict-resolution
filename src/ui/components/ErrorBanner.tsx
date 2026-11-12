import { Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';

interface Props {
  /** What failed, e.g. "Could not save the changes." */
  title: string;
  /** The underlying reason (the database error message). */
  reason?: string;
  /** Shows a Retry button when given. */
  onRetry?: () => void;
}

/** Inline error box shown on the screen where a database operation failed. */
export default function ErrorBanner({ title, reason, onRetry }: Props) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.box, { borderColor: colors.danger, backgroundColor: colors.surface }]}
    >
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.danger }]}>{title}</Text>
        {!!reason && (
          <Text style={[styles.reason, { color: colors.textSecondary }]} numberOfLines={3}>
            {reason}
          </Text>
        )}
      </View>
      {onRetry && (
        <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={8} style={styles.retry}>
          <Text style={[styles.retryText, { color: colors.primary }]}>{strings.retry}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  text: { flex: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  reason: { fontSize: 13, marginTop: 2 },
  retry: { marginLeft: 12, paddingHorizontal: 8, paddingVertical: 6 },
  retryText: { fontSize: 15, fontWeight: '700' },
});
