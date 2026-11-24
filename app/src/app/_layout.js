import { Stack } from 'expo-router';
import '../debug-log';

export default function RootLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
