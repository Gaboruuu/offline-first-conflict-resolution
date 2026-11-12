import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { Dialog } from './Dialog';
import { fieldStyles } from './fieldStyles';

interface Props<T extends string> {
  label: string;
  value: T;
  options: readonly T[];
  getLabel?: (value: T) => string;
  onChange: (value: T) => void;
}

/** Dropdown-like field: shows the current value and opens a dialog listing every option. */
export default function SelectField<T extends string>({ label, value, options, getLabel = (v) => v, onChange }: Props<T>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="combobox"
        accessibilityLabel={label}
        accessibilityValue={{ text: getLabel(value) }}
        style={[fieldStyles.input, fieldStyles.row, { backgroundColor: colors.surface, borderColor: colors.cardStroke }]}
      >
        <Text style={[fieldStyles.inputText, { color: colors.textPrimary }]} numberOfLines={1}>
          {getLabel(value)}
        </Text>
        <Text style={{ color: colors.textSecondary }}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Dialog title={label} onDismiss={() => setOpen(false)} actions={null}>
          <ScrollView style={styles.list}>
            {options.map((option) => {
              const selected = option === value;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    (selected || pressed) && { backgroundColor: colors.primaryContainer },
                  ]}
                >
                  <Text style={[styles.optionText, { color: selected ? colors.primary : colors.textPrimary }]}>
                    {getLabel(option)}
                  </Text>
                  {selected && <Text style={{ color: colors.primary }}>✓</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
        </Dialog>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 360 },
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 12,
  },
  optionText: { fontSize: 16 },
});
