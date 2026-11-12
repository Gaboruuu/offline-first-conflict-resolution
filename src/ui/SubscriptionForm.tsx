import { ReactNode, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BILLING_CYCLE_INFO,
  BILLING_CYCLES,
  BillingCycle,
  CATEGORIES,
  CATEGORY_LABELS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  MAX_NAME_LENGTH,
  NewSubscription,
} from '@/model/Subscription';
import { strings } from '@/strings';
import { Palette } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import DateField from '@/ui/components/DateField';
import ErrorBanner from '@/ui/components/ErrorBanner';
import { fieldStyles } from '@/ui/components/fieldStyles';
import SelectField from '@/ui/components/SelectField';
import { formatAmountInput } from '@/util/money';
import { FormErrors, SubscriptionFormValues, validateSubscriptionForm } from '@/util/validation';

export const EMPTY_FORM: SubscriptionFormValues = {
  name: '',
  amount: '',
  currency: DEFAULT_CURRENCY,
  billingCycle: 'MONTHLY',
  nextPaymentDate: null,
  category: 'OTHER',
  isActive: true,
  notes: '',
};

export function formValuesOf(subscription: NewSubscription): SubscriptionFormValues {
  return { ...subscription, amount: formatAmountInput(subscription.amount) };
}

interface Props {
  initialValues: SubscriptionFormValues;
  submitLabel: string;
  /**
   * Saves the validated element (without an id). Resolves to true when it was saved and the screen
   * is closing, false when saving failed and the user may try again.
   */
  onSubmit: (subscription: NewSubscription) => Promise<boolean>;
  /** Why the last save failed, shown above the submit button. */
  error?: { title: string; reason?: string } | null;
  /** Extra content under the submit button (the update screen's delete button). */
  footer?: ReactNode;
}

/**
 * The form shared by the create and update screens: a visible label above every input,
 * validation on submit with the error shown under the field it belongs to.
 */
export default function SubscriptionForm({ initialValues, submitLabel, onSubmit, error, footer }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const nameInput = useRef<TextInput>(null);
  const amountInput = useRef<TextInput>(null);

  const set = <K extends keyof SubscriptionFormValues>(key: K, value: SubscriptionFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async () => {
    if (submitting.current) return; // ignores a double tap while saving or while the screen is closing
    const result = validateSubscriptionForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      if (result.errors.name) nameInput.current?.focus();
      else if (result.errors.amount) amountInput.current?.focus();
      return;
    }
    submitting.current = true;
    setSaving(true);
    const saved = await onSubmit(result.subscription);
    if (!saved) {
      submitting.current = false;
      setSaving(false);
    }
  };

  const inputStyle = (hasError: boolean) => [
    fieldStyles.input,
    styles.input,
    hasError && { borderColor: colors.danger },
  ];

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 24, paddingLeft: insets.left + 20, paddingRight: insets.right + 20 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Label text={strings.labelName} style={styles.label} first />
        <TextInput
          ref={nameInput}
          accessibilityLabel={strings.labelName}
          value={values.name}
          onChangeText={(text) => set('name', text)}
          placeholder={strings.placeholderName}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="words"
          returnKeyType="next"
          onSubmitEditing={() => amountInput.current?.focus()}
          style={inputStyle(!!errors.name)}
        />
        <View style={styles.underRow}>
          <ErrorText message={errors.name} color={colors.danger} />
          <Text
            style={[
              fieldStyles.helper,
              { color: values.name.trim().length > MAX_NAME_LENGTH ? colors.danger : colors.textSecondary },
            ]}
          >
            {values.name.trim().length}/{MAX_NAME_LENGTH}
          </Text>
        </View>

        <View style={styles.amountRow}>
          <View style={styles.amountColumn}>
            <Label text={strings.labelAmount} style={styles.label} first />
            <TextInput
              ref={amountInput}
              accessibilityLabel={strings.labelAmount}
              value={values.amount}
              onChangeText={(text) => set('amount', text)}
              placeholder={strings.placeholderAmount}
              placeholderTextColor={colors.textSecondary}
              keyboardType="decimal-pad"
              returnKeyType="done"
              style={inputStyle(!!errors.amount)}
            />
            <ErrorText message={errors.amount} color={colors.danger} />
          </View>
          <View style={styles.currencyColumn}>
            <Label text={strings.labelCurrency} style={styles.label} first />
            <SelectField
              label={strings.labelCurrency}
              value={values.currency as (typeof CURRENCIES)[number]}
              options={CURRENCIES}
              onChange={(currency) => set('currency', currency)}
            />
          </View>
        </View>

        <Label text={strings.labelBillingCycle} style={styles.label} />
        <View style={styles.segmented} accessibilityRole="radiogroup">
          {BILLING_CYCLES.map((cycle: BillingCycle) => {
            const selected = values.billingCycle === cycle;
            return (
              <Pressable
                key={cycle}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => set('billingCycle', cycle)}
                style={[styles.segment, selected && styles.segmentSelected]}
              >
                <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
                  {BILLING_CYCLE_INFO[cycle].label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Label text={strings.labelNextPayment} style={styles.label} />
        <DateField
          label={strings.labelNextPayment}
          value={values.nextPaymentDate}
          hasError={!!errors.nextPaymentDate}
          onChange={(date) => set('nextPaymentDate', date)}
        />
        <ErrorText message={errors.nextPaymentDate} color={colors.danger} />

        <Label text={strings.labelCategory} style={styles.label} />
        <SelectField
          label={strings.labelCategory}
          value={values.category}
          options={CATEGORIES}
          getLabel={(category) => CATEGORY_LABELS[category]}
          onChange={(category) => set('category', category)}
        />

        <View style={styles.activeCard}>
          <View style={styles.flex}>
            <Text style={styles.activeLabel}>{strings.labelActive}</Text>
            <Text style={styles.activeHint}>{strings.labelActiveHint}</Text>
          </View>
          <Switch
            accessibilityLabel={strings.labelActive}
            value={values.isActive}
            onValueChange={(isActive) => set('isActive', isActive)}
            trackColor={{ true: colors.primary, false: colors.surfaceVariant }}
            thumbColor={Platform.OS === 'android' ? colors.surface : undefined}
            {...(Platform.OS === 'web' ? { activeThumbColor: colors.surface } : {})}
          />
        </View>

        <Label text={strings.labelNotes} style={styles.label} />
        <TextInput
          accessibilityLabel={strings.labelNotes}
          value={values.notes}
          onChangeText={(text) => set('notes', text)}
          placeholder={strings.placeholderNotes}
          placeholderTextColor={colors.textSecondary}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
          style={[...inputStyle(false), styles.notes]}
        />

        {error && (
          <View style={styles.error}>
            <ErrorBanner title={error.title} reason={error.reason} />
          </View>
        )}

        <Pressable
          onPress={submit}
          disabled={saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving, busy: saving }}
          style={({ pressed }) => [styles.submit, (pressed || saving) && styles.submitPressed]}
        >
          {saving ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.submitText}>{submitLabel}</Text>
          )}
        </Pressable>
        {footer}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Label({ text, style, first }: { text: string; style: object; first?: boolean }) {
  return <Text style={[fieldStyles.label, style, first && { marginTop: 4 }]}>{text}</Text>;
}

function ErrorText({ message, color }: { message?: string; color: string }) {
  if (!message) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={[fieldStyles.error, styles.errorFlex, { color }]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({ errorFlex: { flex: 1 } });

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingTop: 8, width: '100%', maxWidth: 640, alignSelf: 'center' },
    label: { color: c.textSecondary },
    input: { backgroundColor: c.surface, borderColor: c.cardStroke, color: c.textPrimary },
    underRow: { flexDirection: 'row', alignItems: 'flex-start' },
    amountRow: { flexDirection: 'row', marginTop: 4 },
    amountColumn: { flex: 3, marginRight: 12 },
    currencyColumn: { flex: 2 },
    segmented: {
      flexDirection: 'row',
      backgroundColor: c.surfaceVariant,
      borderRadius: 12,
      padding: 4,
    },
    segment: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 9 },
    segmentSelected: { backgroundColor: c.surface },
    segmentText: { fontSize: 15, color: c.textSecondary, fontWeight: '500' },
    segmentTextSelected: { color: c.primary, fontWeight: '700' },
    activeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 20,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.cardStroke,
      backgroundColor: c.surface,
    },
    activeLabel: { fontSize: 16, color: c.textPrimary },
    activeHint: { fontSize: 12, color: c.textSecondary, marginTop: 2, marginRight: 12 },
    notes: { minHeight: 96 },
    error: { marginTop: 24 },
    submit: {
      marginTop: 28,
      minHeight: 56,
      justifyContent: 'center',
      backgroundColor: c.primary,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
    },
    submitPressed: { opacity: 0.85 },
    submitText: { color: c.onPrimary, fontSize: 17, fontWeight: '700' },
  });
