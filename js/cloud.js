// cloud.js — the connection to Supabase (accounts now; synced projects in later stages).
//
// The URL and "publishable" key below are PUBLIC by design: they only identify the project.
// What each person may read or change is enforced inside Supabase by row-level security.
// Never put the service_role / secret key or the database password in this app.
//
// Accounts: email + password. A new account must be confirmed from its email (proves they own
// the address — company auto-join by email domain will rely on this). Forgot password works by email too.
//
// EMAIL_STYLE says what those emails contain:
//   'link' (now)  — Supabase's built-in sender can't have its templates edited, so the emails hold a
//                   link. Tapping it opens the app with sign-in details after the # (handled by
//                   handleEmailLink below).
//   'code' (later) — once we have our own email sender (custom SMTP), edit the "Confirm signup" and
//                   "Reset password" templates to show {{ .Token }} and switch this to 'code'.

import { loadVendorScript } from './export.js';

const SUPABASE_URL = 'https://prgwxaddeuatfkxmorpp.supabase.co';
const SUPABASE_KEY = 'sb_publishable_owBNcOSnw8JgAjT8mmjdpw_CbAfhcTR';

export const EMAIL_STYLE = 'link';

// Where email links send people back to: this same app (works for the live site and for testing).
// Must also be listed in Supabase › Authentication › URL Configuration (Site URL / Redirect URLs).
const APP_URL = location.origin + location.pathname;

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
  const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } });
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
  const { error } = await client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: APP_URL } });
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
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
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

// After a "Forgot password" link signed them in: set the new password.
export async function setNewPassword(newPassword) {
  const client = await getClient();
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw friendly(error);
}

// ---------- Profile and company (database tables: profiles, companies — see supabase/*.sql) ----------

// Same list as private.is_public_email_domain in the database: these never become a company's domain.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'cox.net', 'charter.net', 'bellsouth.net',
]);
export function emailDomain(email) { return String(email || '').split('@')[1]?.toLowerCase() || ''; }
export function isPublicEmailDomain(domain) { return PUBLIC_EMAIL_DOMAINS.has(domain); }

// { id, email, fullName, company: { id, name, domain } | null, companyRole: 'admin' | 'member' | null }
export async function myAccount() {
  const client = await getClient();
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await client.from('profiles')
    .select('id, email, full_name, company_role, company:companies(id, name, domain)')
    .eq('id', user.id).maybeSingle();
  if (error) throw friendly(error);
  if (!data) return { id: user.id, email: user.email, fullName: '', company: null, companyRole: null };
  return { id: data.id, email: data.email, fullName: data.full_name, company: data.company, companyRole: data.company_role };
}

export async function setMyName(fullName) {
  const client = await getClient();
  const user = await currentUser();
  const { error } = await client.from('profiles').update({ full_name: fullName.trim() }).eq('id', user.id);
  if (error) throw friendly(error);
}

// Starts a company with you as its admin. Returns its id.
export async function createCompany(name) {
  const client = await getClient();
  const { data, error } = await client.rpc('create_company', { company_name: name.trim() });
  if (error) throw friendly(error);
  return data;
}

// ---------- Links from account emails ----------
//
// A confirm / reset link opens the app as  …/punch-list/#access_token=…&refresh_token=…&type=signup
// (or #error=…&error_code=otp_expired… if the link is old or already used).
// Call takeEmailLink() before routing: it removes those details from the address bar and returns them.
export function takeEmailLink() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (!/(^|&)(access_token|error_code|error)=/.test(hash)) return null;
  const params = Object.fromEntries(new URLSearchParams(hash));
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  return params;
}

// Signs in with the link's details. Returns 'signup' | 'recovery' | other type. Throws if the link failed.
export async function useEmailLink(params) {
  if (params.error || params.error_code) {
    const expired = params.error_code === 'otp_expired' || /expired|invalid/i.test(params.error_description || '');
    throw new Error(expired
      ? 'That email link has expired or was already used. If you already confirmed, just sign in; otherwise ask for a new email.'
      : `That email link didn't work: ${(params.error_description || params.error || '').replace(/\+/g, ' ')}`);
  }
  const client = await getClient();
  const { error } = await client.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
  if (error) {
    const f = friendly(error);
    throw f.code === 'offline' ? f : new Error('That email link didn\'t work. Try signing in, or ask for a new email.');
  }
  return params.type || 'signin';
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
