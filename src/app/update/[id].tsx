import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { strings } from '@/strings';
import { useTheme } from '@/theme/ThemeProvider';
import SubscriptionForm, { formValuesOf } from '@/ui/SubscriptionForm';
import { useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { friendlyError, logError } from '@/util/log';
import { useNavigateFrom } from '@/util/navigation';

/**
 * Update screen: the form pre-filled with the element identified by the `id` route parameter.
 * The edited element keeps its id; the server element and the local row are updated in place
 * (offline: locally, sent later). A rejected update is logged and shown on this screen.
 */
export default function UpdateSubscriptionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const viewModel = useSubscriptionViewModel();
  const router = useRouter();
  const navigateFrom = useNavigateFrom();
  const { colors } = useTheme();
  const [error, setError] = useState<{ title: string; reason?: string } | null>(null);

  // Read once, from the in-memory cache: the form keeps its own state while the user edits.
  const [original] = useState(() => viewModel.get(Number(id)));

  useEffect(() => {
    if (!original) router.back();
  }, [original, router]);
  if (!original) return null;

  return (
    <SubscriptionForm
      initialValues={formValuesOf(original)}
      submitLabel={strings.actionUpdate}
      error={error}
      onSubmit={async (subscription) => {
        setError(null);
        let updated: unknown;
        try {
          updated = await viewModel.update({ ...subscription, id: original.id });
        } catch (e) {
          logError('Update subscription', e);
          setError({ title: strings.errorUpdate, reason: friendlyError(e) });
          return false;
        }
        if (!updated) {
          logError('Update subscription', `subscription #${original.id} no longer exists`);
          setError({ title: strings.errorUpdate, reason: strings.errorNotFound });
          return false;
        }
        router.back();
        return true;
      }}
      footer={
        <Pressable
          accessibilityRole="button"
          onPress={() => navigateFrom({ pathname: '/delete/[id]', params: { id: original.id } })}
          style={styles.delete}
        >
          <Text style={[styles.deleteText, { color: colors.danger }]}>{strings.actionDelete}</Text>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  delete: { marginTop: 12, paddingVertical: 14, alignItems: 'center', borderRadius: 14 },
  deleteText: { fontSize: 16, fontWeight: '600' },
});
