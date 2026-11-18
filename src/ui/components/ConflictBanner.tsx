import { Pressable, StyleSheet, Text } from 'react-native';

import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';

/** Shown above the list while the replica has unresolved conflicts; opens the conflict screen. */
export default function ConflictBanner({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors } = useTheme();
  if (count === 0) return null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${strings.conflictBanner(count)}. ${strings.conflictBannerAction}`}
      style={({ pressed }) => [
        styles.box,
        { backgroundColor: colors.surface, borderColor: colors.dueSoon },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.text, { color: colors.textPrimary }]}>⚠ {strings.conflictBanner(count)}</Text>
      <Text style={[styles.action, { color: colors.primary }]}>{strings.conflictBannerAction}</Text>
    </Pressable>
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
    paddingVertical: 10,
  },
  pressed: { opacity: 0.85 },
  text: { flex: 1, fontSize: 14, fontWeight: '600' },
  action: { marginLeft: 12, fontSize: 15, fontWeight: '700' },
});
