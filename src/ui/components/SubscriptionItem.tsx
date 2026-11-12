import { memo, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';

import { LocalSubscription } from '@/data/SubscriptionDao';
import { BILLING_CYCLE_INFO, CATEGORY_LABELS } from '@/model/Subscription';
import { strings } from '@/strings';
import { Palette } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import { daysBetween, todayIso } from '@/util/dates';
import { DUE_SOON_DAYS, dueText } from '@/util/due';
import { formatMoney } from '@/util/money';

const INACTIVE_OPACITY = 0.55;

interface Props {
  item: LocalSubscription;
  onPress: (id: number) => void;
  onSwipeDelete: (id: number) => void;
}

/**
 * One row of the list. Memoised on the element itself: when the repository replaces a single
 * subscription, only that row renders again. Swiping left asks for a delete confirmation.
 * Elements whose latest change has not reached the server yet show a "Not synced" mark.
 */
function SubscriptionItem({ item, onPress, onSwipeDelete }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const swipeable = useRef<Swipeable>(null);

  const category = colors.category[item.category];
  const days = daysBetween(todayIso(), item.nextPaymentDate);
  const highlight = item.isActive && days <= DUE_SOON_DAYS;
  const cycle = item.isActive ? BILLING_CYCLE_INFO[item.billingCycle].label : strings.paused;
  const pending = item.syncState !== 'SYNCED';

  return (
    <Swipeable
      ref={swipeable}
      friction={2}
      rightThreshold={80}
      overshootRight={false}
      containerStyle={styles.swipeContainer}
      renderRightActions={() => (
        <View style={styles.swipeAction}>
          <Text style={styles.swipeActionText}>{strings.swipeDelete}</Text>
        </View>
      )}
      onSwipeableOpen={() => {
        // Put the row back; it is only removed if the user confirms the dialog.
        swipeable.current?.close();
        onSwipeDelete(item.id);
      }}
    >
      <Pressable
        onPress={() => onPress(item.id)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${formatMoney(item.amount, item.currency)}${pending ? `, ${strings.notSynced}` : ''}`}
        style={({ pressed }) => [
          styles.card,
          highlight && styles.cardHighlight,
          !item.isActive && { opacity: INACTIVE_OPACITY },
          pressed && styles.cardPressed,
        ]}
      >
        <View style={[styles.avatar, { backgroundColor: category.bg }]}>
          <Text style={[styles.avatarText, { color: category.fg }]}>
            {item.name.trim().charAt(0).toUpperCase() || '?'}
          </Text>
        </View>
        <View style={styles.middle}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            {pending && (
              <Text style={styles.pending} accessibilityElementsHidden importantForAccessibility="no">
                {'⟳ '}
                {strings.notSynced}
              </Text>
            )}
          </View>
          <Text style={styles.details} numberOfLines={1}>
            {strings.itemDetails(cycle, dueText(item.nextPaymentDate))}
          </Text>
        </View>
        <View style={styles.end}>
          <Text style={styles.amount}>{formatMoney(item.amount, item.currency)}</Text>
          <Text style={[styles.chip, { backgroundColor: category.bg, color: category.fg }]}>
            {CATEGORY_LABELS[item.category]}
          </Text>
        </View>
      </Pressable>
    </Swipeable>
  );
}

export default memo(SubscriptionItem);

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    swipeContainer: { marginBottom: 10, borderRadius: 16 },
    swipeAction: {
      flex: 1,
      backgroundColor: c.danger,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingHorizontal: 24,
      minWidth: 120,
    },
    swipeActionText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 14,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.cardStroke,
    },
    cardHighlight: { borderWidth: 2, borderColor: c.dueSoon, padding: 13 },
    cardPressed: { backgroundColor: c.surfaceVariant },
    avatar: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 20, fontWeight: '700' },
    middle: { flex: 1, marginHorizontal: 14 },
    nameRow: { flexDirection: 'row', alignItems: 'center' },
    name: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: c.textPrimary },
    pending: { marginLeft: 8, fontSize: 12, fontWeight: '600', color: c.dueSoon },
    details: { marginTop: 4, fontSize: 14, color: c.textSecondary },
    end: { alignItems: 'flex-end' },
    amount: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    chip: {
      marginTop: 6,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 999,
      overflow: 'hidden',
      fontSize: 12,
      fontWeight: '500',
    },
  });
