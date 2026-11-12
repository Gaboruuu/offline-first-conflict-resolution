import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

interface Props {
  title: string;
  children?: ReactNode;
  actions: ReactNode;
  onDismiss: () => void;
}

/** Material-style dialog card centred over a dimmed scrim; tapping the scrim dismisses it. */
export function Dialog({ title, children, actions, onDismiss }: Props) {
  const { colors } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.center]}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        onPress={onDismiss}
        accessibilityLabel="Dismiss"
      />
      <View accessibilityRole="alert" style={[styles.card, { backgroundColor: colors.surface }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        {children}
        <View style={styles.actions}>{actions}</View>
      </View>
    </View>
  );
}

export function DialogButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.button} hitSlop={6}>
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 24,
    paddingTop: 24,
    paddingHorizontal: 24,
    paddingBottom: 12,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12, gap: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 20 },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
