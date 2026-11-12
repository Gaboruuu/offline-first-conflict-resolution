import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

const VISIBLE_MS = 2500;

interface Props {
  /** Message to show; a new `key` re-shows the same text. */
  message: { text: string; key: number } | null;
  bottom: number;
  onHidden: () => void;
}

/** Short confirmation shown at the bottom of the list after a create / update / delete. */
export default function Snackbar({ message, bottom, onHidden }: Props) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!message) return;
    opacity.setValue(0);
    const animation = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.delay(VISIBLE_MS),
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => finished && onHidden());
    return () => animation.stop();
  }, [message, opacity, onHidden]);

  if (!message) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityLiveRegion="polite"
      style={[styles.container, { bottom, opacity, backgroundColor: colors.snackbar }]}
    >
      <Text style={[styles.text, { color: colors.onSnackbar }]}>{message.text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 14,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  text: { fontSize: 14 },
});
