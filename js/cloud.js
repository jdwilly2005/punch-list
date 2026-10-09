// cloud.js — the connection to Supabase (accounts now; synced projects in later stages).
//
// The URL and "publishable" key below are PUBLIC by design: they only identify the project.
// What each person may read or change is enforced inside Supabase by row-level security.
// Never put the service_role / secret key or the database password in this app.
//
// Accounts: email + password. A new account is confirmed with a 6-digit code emailed to that
// address (proves they own it — company auto-join by email domain will rely on this).
// Forgot password also works with an emailed code. The codes come from the Supabase email
// templates "Confirm signup" and "Reset password", which must contain {{ .Token }}.

import { loadVendorScript } from './export.js';

const SUPABASE_URL = 'https://prgwxaddeuatfkxmorpp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_owBNcOSnw8JgAjT8mmjdpw_CbAfhcTR';

let clientPromise = null;

// The Supabase client, loaded the first time it's needed (~200 KB, saved for offline use).
export function getClient() {
  if (!clientPromise) {
    clientPromise = loadVendorScript('supabase.min.js', 'supabase')
      .then(() => window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      }))
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

// The signed-in user ({ id, email, ... }) or null. Works offline: the session is saved on the device.
export async function currentUser() {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  return data.session ? data.session.user : null;
}

// Runs fn(user or null) whenever someone signs in or out. Returns a function that stops listening.
export async function onAccountChange(fn) {
  const client = await getClient();
  const { data } = client.auth.onAuthStateChange((_event, session) => fn(session ? session.user : null));
  return () => data.subscription.unsubscribe();
}

// ---------- Account actions (each throws an Error with a plain-English message) ----------

export async function signUp(email, password) {
  const client = await getClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw friendly(error);
  // Supabase hides whether an address is taken: an existing account comes back with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('There\'s already an account with this email. Sign in instead, or use "Forgot password".');
  }
}

export async function verifySignUp(email, code) {
  const client = await getClient();
  const { error } = await client.auth.verifyOtp({ email, token: code, type: 'signup' });
  if (error) throw friendly(error);
}

export async function resendSignUpCode(email) {
  const client = await getClient();
  const { error } = await client.auth.resend({ type: 'signup', email });
  if (error) throw friendly(error);
}

export async function signIn(email, password) {
  const client = await getClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw friendly(error);
}

export async function signOut() {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) throw friendly(error);
}

export async function sendPasswordResetCode(email) {
  const client = await getClient();
  const { error } = await client.auth.resetPasswordForEmail(email);
  if (error) throw friendly(error);
}

// Checks the emailed code (which signs them in), then sets the new password.
export async function resetPassword(email, code, newPassword) {
  const client = await getClient();
  const { error } = await client.auth.verifyOtp({ email, token: code, type: 'recovery' });
  if (error) throw friendly(error);
  const { error: err2 } = await client.auth.updateUser({ password: newPassword });
  if (err2) throw friendly(err2);
}

// Supabase's error messages, reworded for people on a job site.
function friendly(error) {
  const code = error.code || '';
  const msg = error.message || String(error);
  const map = {
    invalid_credentials: 'Wrong email or password.',
    email_not_confirmed: 'This email hasn\'t been confirmed yet. Enter the code we emailed you.',
    otp_expired: 'That code is wrong or has expired. Check the latest email, or send a new code.',
    weak_password: 'That password is too weak. Use at least 8 characters, mixing letters and numbers.',
    over_email_send_rate_limit: 'Too many emails sent for now. Wait a few minutes and try again.',
    over_request_rate_limit: 'Too many tries. Wait a few minutes and try again.',
    user_already_exists: 'There\'s already an account with this email. Sign in instead.',
    email_address_invalid: 'That email address doesn\'t look right.',
    same_password: 'That\'s already your password. Choose a new one.',
  };
  if (map[code]) return Object.assign(new Error(map[code]), { code });
  if (/fetch|network|load failed/i.test(msg)) {
    return Object.assign(new Error('No connection. Accounts need signal; try again when you\'re online.'), { code: 'offline' });
  }
  return Object.assign(new Error(msg), { code });
}
