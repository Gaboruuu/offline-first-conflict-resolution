import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import '@/sync/polyfills';

import { openSubTrackDatabase } from '@/data/database';
import { serverUrl, webSocketUrl } from '@/data/serverConfig';
import { WebSocketEventSource } from '@/data/ServerEvents';
import { SqliteSubscriptionDao } from '@/data/SqliteSubscriptionDao';
import { HttpSyncTransport } from '@/data/SyncApi';
import { SyncRepository } from '@/data/SyncRepository';
import { strings } from '@/strings';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { SubscriptionViewModelProvider } from '@/ui/SubscriptionViewModel';
import { newId } from '@/util/ids';
import { logDebug } from '@/util/log';

/** The app's single repository: the local replica in SQLite, synced with the SubTrack server. */
const createRepository = () => {
  const baseUrl = serverUrl();
  logDebug('App', `server ${baseUrl}`);
  return new SyncRepository({
    store: new SqliteSubscriptionDao(openSubTrackDatabase),
    transport: new HttpSyncTransport({ baseUrl }),
    serverEvents: new WebSocketEventSource(webSocketUrl(baseUrl)),
    newId,
  });
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
        <Stack.Screen name="conflicts" options={{ title: strings.titleConflicts }} />
        <Stack.Screen name="developer" options={{ title: strings.titleDeveloper }} />
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
