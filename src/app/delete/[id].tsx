import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';
import { Dialog, DialogButton } from '@/ui/components/Dialog';
import ErrorBanner from '@/ui/components/ErrorBanner';
import { useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { friendlyError, logError } from '@/util/log';

/**
 * Delete screen: a confirmation dialog; only the id of the element is passed to the view model,
 * and only the server id is sent to the server (queued while offline). A failed delete is logged
 * and shown in the dialog with a friendly message.
 */
export default function DeleteSubscriptionDialog() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const viewModel = useSubscriptionViewModel();
  const router = useRouter();
  const { colors } = useTheme();
  const [subscription] = useState(() => viewModel.get(id));
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subscription) router.back();
  }, [subscription, router]);
  if (!subscription) return null;

  const cancel = () => {
    if (!deleting) router.back();
  };
  const confirm = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    let deleted: unknown;
    try {
      deleted = await viewModel.delete(subscription.id);
    } catch (e) {
      logError('Delete subscription', e);
      setError(friendlyError(e));
      setDeleting(false);
      return;
    }
    if (!deleted) {
      logError('Delete subscription', `subscription ${subscription.id} no longer exists`);
      setError(strings.errorNotFound);
      setDeleting(false);
      return;
    }
    // Return to the list, closing the update screen too when deleting from there.
    router.dismissAll();
  };

  return (
    <Dialog
      title={strings.deleteTitle(subscription.name)}
      onDismiss={cancel}
      actions={
        deleting ? (
          <ActivityIndicator style={styles.progress} color={colors.danger} />
        ) : (
          <>
            <DialogButton label={strings.cancel} color={colors.primary} onPress={cancel} />
            <DialogButton label={strings.delete} color={colors.danger} onPress={confirm} />
          </>
        )
      }
    >
      <Text style={[styles.message, { color: colors.textSecondary }]}>{strings.deleteMessage}</Text>
      {error && (
        <View style={styles.error}>
          <ErrorBanner title={strings.errorDelete} reason={error} />
        </View>
      )}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  message: { fontSize: 15, lineHeight: 22 },
  error: { marginTop: 16 },
  progress: { paddingHorizontal: 12, paddingVertical: 10 },
});
