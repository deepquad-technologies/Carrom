import React, { useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, styles } from '../theme';
import { useSession } from '../lib/session';

type Mode = 'choose' | 'signin' | 'register';

export default function LoginScreen() {
  const {
    signInWithEmail, registerWithEmail, continueAsGuest, continueWithFacebook,
    continueWithGoogle, facebookAvailable, googleAvailable, loading, error,
  } = useSession();

  const [mode, setMode] = useState<Mode>('choose');
  const [form, setForm] = useState({ email: '', password: '', username: '' });

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: 'center' }]}>
        <View style={[styles.center, { marginBottom: 28 }]}>
          <LinearGradient
            colors={[colors.brass, colors.brassDark]}
            style={{ width: 68, height: 68, borderRadius: 20, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 32, fontWeight: '900', color: '#07080d' }}>C</Text>
          </LinearGradient>
          <Text style={[styles.title, { marginTop: 16, fontSize: 32 }]}>Carrom Club</Text>
          <Text style={[styles.muted, { marginTop: 6 }]}>
            Real carrom rules. Real opponents. Play free.
          </Text>
        </View>

        <View style={styles.panel}>
          {error ? (
            <View
              style={{
                backgroundColor: 'rgba(239,68,68,0.12)',
                borderColor: 'rgba(239,68,68,0.35)',
                borderWidth: 1,
                borderRadius: 12,
                padding: 12,
                marginBottom: 14,
              }}
            >
              <Text style={{ color: '#fca5a5', fontSize: 13 }}>{error}</Text>
            </View>
          ) : null}

          {mode === 'choose' ? (
            <View style={{ gap: 10 }}>
              {facebookAvailable ? (
                <Pressable
                  style={[styles.button, { backgroundColor: '#1877F2' }]}
                  onPress={() => void continueWithFacebook()}
                  disabled={loading}
                >
                  <Text style={[styles.buttonPrimaryText, { color: '#fff' }]}>
                    Continue with Facebook
                  </Text>
                </Pressable>
              ) : null}

              {googleAvailable ? (
                <Pressable
                  style={[styles.button, { backgroundColor: '#fff' }]}
                  onPress={() => void continueWithGoogle()}
                  disabled={loading}
                >
                  <Text style={[styles.buttonPrimaryText, { color: '#1f1f1f' }]}>
                    Continue with Google
                  </Text>
                </Pressable>
              ) : null}

              <Pressable
                style={[styles.button, styles.buttonGhost]}
                onPress={() => setMode('signin')}
              >
                <Text style={styles.buttonGhostText}>Sign in with email</Text>
              </Pressable>

              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={() => void continueAsGuest()}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#07080d" />
                ) : (
                  <Text style={styles.buttonPrimaryText}>Play now as guest</Text>
                )}
              </Pressable>

              {!facebookAvailable && !googleAvailable ? (
                <Text style={[styles.faint, { textAlign: 'center', marginTop: 4 }]}>
                  Social sign-in appears once the app is built with provider ids.
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={{ gap: 12 }}>
              <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                keyboardType="email-address"
                value={form.email}
                onChangeText={(email) => setForm({ ...form, email })}
              />

              {mode === 'register' ? (
                <TextInput
                  style={styles.input}
                  placeholder="Username"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  maxLength={20}
                  value={form.username}
                  onChangeText={(username) => setForm({ ...form, username })}
                />
              ) : null}

              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                value={form.password}
                onChangeText={(password) => setForm({ ...form, password })}
              />

              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                disabled={loading}
                onPress={() => {
                  if (mode === 'signin') {
                    void signInWithEmail({ email: form.email, password: form.password });
                  } else {
                    void registerWithEmail(form);
                  }
                }}
              >
                {loading ? (
                  <ActivityIndicator color="#07080d" />
                ) : (
                  <Text style={styles.buttonPrimaryText}>
                    {mode === 'signin' ? 'Sign in' : 'Create account'}
                  </Text>
                )}
              </Pressable>

              <View style={[styles.row, { justifyContent: 'space-between' }]}>
                <Pressable onPress={() => setMode(mode === 'signin' ? 'register' : 'signin')}>
                  <Text style={styles.muted}>
                    {mode === 'signin' ? 'Create an account' : 'I have an account'}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setMode('choose')}>
                  <Text style={styles.muted}>Back</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        <Text style={[styles.faint, { textAlign: 'center', lineHeight: 16, marginTop: 18 }]}>
          Coins in this game are virtual and have no cash value. There is no deposit,
          withdrawal, or wagering of real money.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
