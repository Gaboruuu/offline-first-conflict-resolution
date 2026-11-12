import { createElement } from 'react';

import { useTheme } from '@/theme/ThemeProvider';
import { isIsoDate } from '@/util/dates';
import type { DateFieldProps } from './DateField';

/** Web version of the date field: the browser's own `<input type="date">`. */
export default function DateField({ label, value, hasError, onChange }: DateFieldProps) {
  const { colors, isDark } = useTheme();
  return createElement('input', {
    type: 'date',
    'aria-label': label,
    value: value ?? '',
    onChange: (event: { target: { value: string } }) => {
      if (isIsoDate(event.target.value)) onChange(event.target.value);
    },
    style: {
      minHeight: 52,
      boxSizing: 'border-box',
      width: '100%',
      borderRadius: 12,
      border: `1px solid ${hasError ? colors.danger : colors.cardStroke}`,
      padding: '12px 16px',
      fontSize: 16,
      fontFamily: 'inherit',
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      colorScheme: isDark ? 'dark' : 'light',
    },
  });
}
