import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { THEME_PREFERENCES, ThemePreference, useTheme } from '@/theme/ThemeProvider';
import { Dialog, DialogButton } from './Dialog';

const LABELS: Record<ThemePreference, string> = {
  system: strings.themeSystem,
  light: strings.themeLight,
  dark: strings.themeDark,
};

/** Lets the user pick System default / Light / Dark. */
export default function ThemeDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, preference, setPreference } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Dialog
        title={strings.actionTheme}
        onDismiss={onClose}
        actions={<DialogButton label={strings.cancel} color={colors.primary} onPress={onClose} />}
      >
        {THEME_PREFERENCES.map((option) => {
          const selected = option === preference;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              style={styles.row}
              onPress={() => {
                setPreference(option);
                onClose();
              }}
            >
              <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.textSecondary }]}>
                {selected && <View style={[styles.radioDot, { backgroundColor: colors.primary }]} />}
              </View>
              <Text style={[styles.label, { color: colors.textPrimary }]}>{LABELS[option]}</Text>
            </Pressable>
          );
        })}
      </Dialog>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 16 },
});
