import React, { useState } from 'react';
import { ActivityIndicator, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { formatCoins } from '@carrom/config';
import { SessionProvider, useSession } from './lib/session';
import { colors, styles } from './theme';
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import PlayScreen from './screens/PlayScreen';
import LockerScreen from './screens/LockerScreen';
import CratesScreen from './screens/CratesScreen';
import StoreScreen from './screens/StoreScreen';
import ProfileScreen from './screens/ProfileScreen';

const Tab = createBottomTabNavigator();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.brass,
  },
};

const TAB_ICONS: Record<string, string> = {
  Home: '\u{1F3E0}',
  Play: '\u{1F3AF}',
  Locker: '\u{1F392}',
  Crates: '\u{1F381}',
  Store: '\u{1F6D2}',
  Profile: '\u{1F464}',
};

function CoinHeader() {
  const { profile } = useSession();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: colors.bg,
      }}
    >
      <View style={[styles.chip, { borderColor: 'rgba(242,201,76,0.35)' }]}>
        <Text style={[styles.chipText, { color: colors.brass }]}>
          {formatCoins(profile?.coins ?? 0)} coins
        </Text>
      </View>
    </View>
  );
}

function Tabs() {
  const [, setTab] = useState('Home');

  return (
    <>
      <CoinHeader />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.brass,
          tabBarInactiveTintColor: colors.textFaint,
          tabBarStyle: {
            backgroundColor: colors.bg,
            borderTopColor: colors.border,
            height: 62,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
          tabBarIcon: ({ color }) => (
            <Text style={{ fontSize: 20, color }}>{TAB_ICONS[route.name] ?? '•'}</Text>
          ),
        })}
        screenListeners={{ state: (event) => {
          const state = event.data.state as { index: number; routeNames: string[] } | undefined;
          if (state) setTab(state.routeNames[state.index]);
        } }}
      >
        <Tab.Screen name="Home">
          {({ navigation }) => <HomeScreen onPlay={() => navigation.navigate('Play')} />}
        </Tab.Screen>
        <Tab.Screen name="Play" component={PlayScreen} />
        <Tab.Screen name="Locker" component={LockerScreen} />
        <Tab.Screen name="Crates" component={CratesScreen} />
        <Tab.Screen name="Store" component={StoreScreen} />
        <Tab.Screen name="Profile" component={ProfileScreen} />
      </Tab.Navigator>
    </>
  );
}

function Root() {
  const { signedIn, loading } = useSession();

  if (loading && !signedIn) {
    return (
      <SafeAreaView style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.brass} size="large" />
        <Text style={[styles.muted, { marginTop: 14 }]}>Setting up the board…</Text>
      </SafeAreaView>
    );
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.screen}>
        <LoginScreen />
      </SafeAreaView>
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      <SafeAreaView style={styles.screen} edges={['top']}>
        <Tabs />
      </SafeAreaView>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <SessionProvider>
          <Root />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
