import Constants from 'expo-constants';

const SERVER_PORT = 3000;

/**
 * Base URL of the SubTrack server. `EXPO_PUBLIC_SERVER_URL` wins when set (e.g. in `.env.local`);
 * otherwise the server is expected on the computer that runs the Expo dev server, which the phone
 * already reaches through `hostUri` (its LAN address).
 */
export function serverUrl(): string {
  const configured = process.env.EXPO_PUBLIC_SERVER_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const host = Constants.expoConfig?.hostUri?.split(':')[0] || 'localhost';
  return `http://${host}:${SERVER_PORT}`;
}

export const webSocketUrl = (baseUrl: string) => `${baseUrl.replace(/^http/, 'ws')}/ws`;
