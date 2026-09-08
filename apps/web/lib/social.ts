'use client';

/**
 * Facebook and Google sign-in from the browser.
 *
 * Both flows end the same way: the provider hands us a token, we post it to our
 * own API, and the API verifies it with the provider before trusting anything.
 * Only public client ids appear here — the app secret never leaves the server.
 */
declare global {
  interface Window {
    FB?: {
      init(options: Record<string, unknown>): void;
      login(
        callback: (response: FacebookLoginResponse) => void,
        options?: { scope: string; return_scopes?: boolean },
      ): void;
      logout(callback: () => void): void;
      getLoginStatus(callback: (response: FacebookLoginResponse) => void): void;
    };
    fbAsyncInit?: () => void;
    google?: {
      accounts: {
        id: {
          initialize(config: Record<string, unknown>): void;
          prompt(listener?: (notification: unknown) => void): void;
          renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
  }
}

interface FacebookLoginResponse {
  status: 'connected' | 'not_authorized' | 'unknown';
  authResponse?: {
    accessToken: string;
    userID: string;
    grantedScopes?: string;
  };
}

export const FACEBOOK_APP_ID = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID ?? '';
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

export const facebookConfigured = FACEBOOK_APP_ID.length > 0;
export const googleConfigured = GOOGLE_CLIENT_ID.length > 0;

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) return resolve();
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

let facebookReady: Promise<void> | null = null;

async function initFacebook(): Promise<void> {
  if (!facebookConfigured) throw new Error('Facebook sign-in is not configured');

  facebookReady ??= new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: FACEBOOK_APP_ID,
        cookie: true,
        xfbml: false,
        version: 'v21.0',
      });
      resolve();
    };
    loadScript('https://connect.facebook.net/en_US/sdk.js', 'facebook-jssdk').catch(reject);
  });

  return facebookReady;
}

export interface SocialToken {
  provider: 'facebook' | 'google';
  token: string;
  /** Permissions the user actually granted; email is optional and often declined. */
  grantedScopes?: string[];
}

/**
 * Opens the Facebook dialog. `email` is requested but declining it is a normal
 * outcome, not an error, so the caller should not depend on getting one.
 */
export function signInWithFacebook(): Promise<SocialToken> {
  return initFacebook().then(
    () =>
      new Promise<SocialToken>((resolve, reject) => {
        if (!window.FB) return reject(new Error('Facebook SDK did not load'));

        window.FB.login(
          (response) => {
            if (response.status === 'connected' && response.authResponse) {
              resolve({
                provider: 'facebook',
                token: response.authResponse.accessToken,
                grantedScopes: response.authResponse.grantedScopes?.split(','),
              });
              return;
            }
            if (response.status === 'not_authorized') {
              reject(new Error('You need to allow the app to continue with Facebook'));
              return;
            }
            reject(new Error('Facebook sign-in was cancelled'));
          },
          { scope: 'public_profile,email', return_scopes: true },
        );
      }),
  );
}

export async function facebookLogout(): Promise<void> {
  if (!facebookConfigured || !window.FB) return;
  await new Promise<void>((resolve) => window.FB!.logout(() => resolve()));
}

let googleReady: Promise<void> | null = null;

async function initGoogle(): Promise<void> {
  if (!googleConfigured) throw new Error('Google sign-in is not configured');
  googleReady ??= loadScript('https://accounts.google.com/gsi/client', 'google-gsi');
  await googleReady;
}

/**
 * Google Identity Services returns an ID token through a callback rather than a
 * promise, so this bridges the two.
 */
export async function signInWithGoogle(): Promise<SocialToken> {
  await initGoogle();

  return new Promise<SocialToken>((resolve, reject) => {
    if (!window.google) return reject(new Error('Google SDK did not load'));

    let settled = false;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response: { credential?: string }) => {
        if (settled) return;
        settled = true;
        if (response.credential) resolve({ provider: 'google', token: response.credential });
        else reject(new Error('Google sign-in did not return a token'));
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    window.google.accounts.id.prompt((notification: unknown) => {
      const note = notification as { isNotDisplayed?: () => boolean; isSkippedMoment?: () => boolean };
      if (settled) return;
      if (note.isNotDisplayed?.() || note.isSkippedMoment?.()) {
        settled = true;
        reject(new Error('Google sign-in was dismissed. Check pop-up settings and try again.'));
      }
    });
  });
}

/** Renders the official Google button, which is more reliable than One Tap. */
export async function renderGoogleButton(
  parent: HTMLElement,
  onToken: (token: SocialToken) => void,
): Promise<void> {
  await initGoogle();
  if (!window.google) return;

  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response: { credential?: string }) => {
      if (response.credential) onToken({ provider: 'google', token: response.credential });
    },
  });
  window.google.accounts.id.renderButton(parent, {
    theme: 'filled_black',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    width: 280,
  });
}
