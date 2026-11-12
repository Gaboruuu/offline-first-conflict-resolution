import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, Text, View } from 'react-native';

import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';
import { formatDate, isoToLocalDate, localDateToIso, todayIso } from '@/util/dates';
import { Dialog, DialogButton } from './Dialog';
import { fieldStyles } from './fieldStyles';

export interface DateFieldProps {
  label: string;
  value: string | null;
  hasError: boolean;
  onChange: (iso: string) => void;
}

/** Read-only field showing the chosen date; tapping it opens the platform date picker. */
export default function DateField({ label, value, hasError, onChange }: DateFieldProps) {
  const { colors, isDark } = useTheme();
  const [iosDraft, setIosDraft] = useState<Date | null>(null);
  const current = isoToLocalDate(value ?? todayIso());

  const open = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: current,
        mode: 'date',
        onChange: (event, date) => {
          if (event.type === 'set' && date) onChange(localDateToIso(date));
        },
      });
    } else {
      setIosDraft(current);
    }
  };

  return (
    <>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={strings.pickDate}
        style={[
          fieldStyles.input,
          fieldStyles.row,
          { backgroundColor: colors.surface, borderColor: hasError ? colors.danger : colors.cardStroke },
        ]}
      >
        <Text style={[fieldStyles.inputText, { color: value ? colors.textPrimary : colors.textSecondary }]}>
          {value ? formatDate(value) : strings.placeholderDate}
        </Text>
        <Text style={{ color: colors.primary, fontSize: 18 }}>📅</Text>
      </Pressable>

      {iosDraft && (
        <Modal transparent animationType="fade" onRequestClose={() => setIosDraft(null)}>
          <Dialog
            title={label}
            onDismiss={() => setIosDraft(null)}
            actions={
              <>
                <DialogButton label={strings.cancel} color={colors.primary} onPress={() => setIosDraft(null)} />
                <DialogButton
                  label={strings.done}
                  color={colors.primary}
                  onPress={() => {
                    onChange(localDateToIso(iosDraft));
                    setIosDraft(null);
                  }}
                />
              </>
            }
          >
            <View>
              <DateTimePicker
                value={iosDraft}
                mode="date"
                display="inline"
                themeVariant={isDark ? 'dark' : 'light'}
                accentColor={colors.primary}
                onChange={(_, date) => date && setIosDraft(date)}
              />
            </View>
          </Dialog>
        </Modal>
      )}
    </>
  );
}
