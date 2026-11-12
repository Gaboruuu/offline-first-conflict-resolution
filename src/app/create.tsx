import { useRouter } from 'expo-router';
import { useState } from 'react';

import { strings } from '@/strings';
import SubscriptionForm, { EMPTY_FORM } from '@/ui/SubscriptionForm';
import { useSubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { friendlyError, logError } from '@/util/log';

/**
 * Create screen: an empty form; only the new element is handed to the view model and sent to the
 * server, which assigns its id (offline: stored locally and sent later). A rejected create is
 * logged and shown on this screen with a friendly message.
 */
export default function CreateSubscriptionScreen() {
  const viewModel = useSubscriptionViewModel();
  const router = useRouter();
  const [error, setError] = useState<{ title: string; reason?: string } | null>(null);

  return (
    <SubscriptionForm
      initialValues={EMPTY_FORM}
      submitLabel={strings.actionCreate}
      error={error}
      onSubmit={async (subscription) => {
        setError(null);
        try {
          await viewModel.add(subscription);
        } catch (e) {
          logError('Create subscription', e);
          setError({ title: strings.errorCreate, reason: friendlyError(e) });
          return false;
        }
        router.back();
        return true;
      }}
    />
  );
}
