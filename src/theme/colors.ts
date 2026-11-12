import { Category } from '@/model/Subscription';

export interface Palette {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  background: string;
  surface: string;
  surfaceVariant: string;
  textPrimary: string;
  textSecondary: string;
  cardStroke: string;
  dueSoon: string;
  danger: string;
  scrim: string;
  /** Summary card: the same indigo → violet gradient in light and dark mode. */
  summaryStart: string;
  summaryEnd: string;
  summaryText: string;
  summaryTextMuted: string;
  summaryPill: string;
  snackbar: string;
  onSnackbar: string;
  category: Record<Category, { bg: string; fg: string }>;
}

export const lightColors: Palette = {
  primary: '#4F46E5',
  onPrimary: '#FFFFFF',
  primaryContainer: '#E0E7FF',
  background: '#F3F4F8',
  surface: '#FFFFFF',
  surfaceVariant: '#E5E7EB',
  textPrimary: '#111827',
  textSecondary: '#6B7280',
  cardStroke: '#E5E7EB',
  dueSoon: '#F59E0B',
  danger: '#DC2626',
  scrim: 'rgba(0, 0, 0, 0.45)',
  summaryStart: '#4F46E5',
  summaryEnd: '#7C3AED',
  summaryText: '#FFFFFF',
  summaryTextMuted: '#DDD6FE',
  summaryPill: 'rgba(255, 255, 255, 0.2)',
  snackbar: '#1F2937',
  onSnackbar: '#F9FAFB',
  category: {
    ENTERTAINMENT: { bg: '#EDE9FE', fg: '#6D28D9' },
    UTILITIES: { bg: '#E0F2FE', fg: '#0369A1' },
    HEALTH_FITNESS: { bg: '#D1FAE5', fg: '#047857' },
    EDUCATION: { bg: '#FEF3C7', fg: '#B45309' },
    WORK: { bg: '#F3F4F6', fg: '#374151' },
    OTHER: { bg: '#FCE7F3', fg: '#BE185D' },
  },
};

export const darkColors: Palette = {
  primary: '#A5B4FC',
  onPrimary: '#1E1B4B',
  primaryContainer: '#312E81',
  background: '#0F1117',
  surface: '#1A1D27',
  surfaceVariant: '#2A2F3C',
  textPrimary: '#F3F4F6',
  textSecondary: '#9CA3AF',
  cardStroke: '#2A2F3C',
  dueSoon: '#FBBF24',
  danger: '#F87171',
  scrim: 'rgba(0, 0, 0, 0.6)',
  summaryStart: '#4F46E5',
  summaryEnd: '#7C3AED',
  summaryText: '#FFFFFF',
  summaryTextMuted: '#DDD6FE',
  summaryPill: 'rgba(255, 255, 255, 0.2)',
  snackbar: '#E5E7EB',
  onSnackbar: '#111827',
  category: {
    ENTERTAINMENT: { bg: '#2E2550', fg: '#C4B5FD' },
    UTILITIES: { bg: '#0F2F45', fg: '#7DD3FC' },
    HEALTH_FITNESS: { bg: '#0E3A2E', fg: '#6EE7B7' },
    EDUCATION: { bg: '#3D2E0B', fg: '#FCD34D' },
    WORK: { bg: '#262A33', fg: '#D1D5DB' },
    OTHER: { bg: '#3F1830', fg: '#F9A8D4' },
  },
};
