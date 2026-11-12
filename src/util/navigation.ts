import { Href, useNavigation, useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * Pushes [href] only while the calling screen is focused, so a double tap during
 * a transition never opens the same screen twice.
 */
export function useNavigateFrom() {
  const navigation = useNavigation();
  const router = useRouter();
  return useCallback(
    (href: Href) => {
      if (navigation.isFocused()) router.push(href);
    },
    [navigation, router],
  );
}
