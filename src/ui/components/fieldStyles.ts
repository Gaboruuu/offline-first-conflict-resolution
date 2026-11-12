import { StyleSheet } from 'react-native';

/** Shared look of the form inputs (colours are applied by each field from the theme). */
export const fieldStyles = StyleSheet.create({
  label: { fontSize: 14, marginTop: 16, marginBottom: 6 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputText: { fontSize: 16, flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  error: { fontSize: 12, marginTop: 4, marginLeft: 4 },
  helper: { fontSize: 12, marginTop: 4, marginRight: 4, textAlign: 'right' },
});
