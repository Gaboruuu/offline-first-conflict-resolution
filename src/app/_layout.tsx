import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { openSubTrackDatabase } from '@/data/database';
import { newClientId, serverUrl, webSocketUrl } from '@/data/serverConfig';
import { WebSocketEventSource } from '@/data/ServerEvents';
import { SqliteSubscriptionDao } from '@/data/SqliteSubscriptionDao';
import { HttpSubscriptionApi } from '@/data/SubscriptionApi';
import { SubscriptionRepository } from '@/data/SubscriptionRepository';
import { strings } from '@/strings';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { SubscriptionViewModelProvider } from '@/ui/SubscriptionViewModel';
import { logDebug } from '@/util/log';

/** The app's single repository: the local SQLite database, synced with the SubTrack server. */
const createRepository = () => {
  const baseUrl = serverUrl();
  const clientId = newClientId();
  logDebug('App', `server ${baseUrl}, client id ${clientId}`);
  return new SubscriptionRepository(
    new SqliteSubscriptionDao(openSubTrackDatabase),
    new HttpSubscriptionApi(baseUrl, clientId),
    new WebSocketEventSource(webSocketUrl(baseUrl)),
    clientId,
  );
};

/** Root of the app: one stack with a destination per CRUD operation. */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SubscriptionViewModelProvider repository={createRepository}>
            <AppStack />
          </SubscriptionViewModelProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function AppStack() {
  const { colors, isDark } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.textPrimary, fontWeight: '700' },
          headerTitleAlign: 'center',
          headerShadowVisible: false,
          headerBackTitle: strings.back,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false, title: strings.appName }} />
        <Stack.Screen name="create" options={{ title: strings.titleCreate }} />
        <Stack.Screen name="update/[id]" options={{ title: strings.titleUpdate }} />
        <Stack.Screen
          name="delete/[id]"
          options={{
            presentation: 'transparentModal',
            animation: 'fade',
            headerShown: false,
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
      </Stack>
    </>
  );
}
