// account.js — the Account pop-up: sign in, create an account (confirmed with an emailed
// 6-digit code), forgot password, and sign out. The cloud calls live in cloud.js.

import * as cloud from './cloud.js';
import { el, toast } from './ui.js';

const MIN_PASSWORD = 8;

// Opens the pop-up. onChange() runs after someone signs in or out.
export async function openAccountDialog({ onChange = () => {} } = {}) {
  let user = null;
  try { user = await cloud.currentUser(); } catch { /* offline and never loaded: show sign-in */ }

  let mode = user ? 'account' : 'signin';
  let email = user ? user.email : '';
  const title = el('h2', {});
  const body = el('div', { class: 'pl-sheet-body account-body' });
  const layer = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet', role: 'dialog', 'aria-label': 'Account' },
      el('div', { class: 'pl-sheet-head' },
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Close'),
        title,
        el('span', { class: 'head-spacer' })),
      body));
  document.body.append(layer);

  function close() { layer.remove(); }

  function go(next) {
    mode = next;
    render();
  }

  // ---------- Small builders ----------

  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  function showError(err) {
    errorBox.textContent = err ? err.message || String(err) : '';
    errorBox.hidden = !err;
  }

  function input(label, props) {
    const node = el('input', { class: 'account-input', ...props });
    return { node, field: el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), node) };
  }

  const emailInput = () => input('Work email', {
    type: 'email', value: email, autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: true,
  });
  const passwordInput = (label, autocomplete) => input(label, {
    type: 'password', autocomplete, minlength: String(MIN_PASSWORD), required: true,
  });
  const codeInput = () => input('Code from the email', {
    type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '8', required: true,
  });
  const link = (text) => el('button', { type: 'button', class: 'link-btn dark' }, text);
  const linkTo = (text, next) => {
    const b = link(text);
    b.addEventListener('click', () => { showError(null); go(next); });
    return b;
  };

  // Wraps a form so its submit button shows "working" and errors appear in the red box.
  function form(fields, buttonText, action) {
    const submit = el('button', { type: 'submit', class: 'btn btn-primary account-submit' }, buttonText);
    const f = el('form', { class: 'account-form', novalidate: true }, ...fields, errorBox, submit);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError(null);
      submit.disabled = true;
      submit.textContent = 'One moment…';
      try {
        await action();
      } catch (err) {
        console.error(err);
        showError(err);
      } finally {
        if (f.isConnected) {
          submit.disabled = false;
          submit.textContent = buttonText;
        }
      }
    });
    return f;
  }

  const cleanEmail = (v) => v.trim().toLowerCase();
  function checkEmail(v) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('Enter a valid email address.');
  }
  function checkPassword(v) {
    if (v.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`);
  }
  function checkCode(v) {
    if (!/^\d{6,8}$/.test(v)) throw new Error('Enter the number from the email (6 digits).');
  }

  // ---------- Screens ----------

  function render() {
    showError(null);
    const screens = { signin, signup, verify, forgot, reset, account };
    body.replaceChildren(...screens[mode]());
    const first = body.querySelector('input');
    if (first && !first.value) setTimeout(() => first.focus(), 50);
  }

  function signin() {
    title.textContent = 'Sign in';
    const e = emailInput();
    const p = passwordInput('Password', 'current-password');
    return [
      el('p', { class: 'meta' }, 'Accounts are getting ready for shared, synced projects. For now, everything still saves on this device as before.'),
      form([e.field, p.field], 'Sign in', async () => {
        email = cleanEmail(e.node.value);
        checkEmail(email);
        try {
          await cloud.signIn(email, p.node.value);
        } catch (err) {
          if (err.code === 'email_not_confirmed') {
            await cloud.resendSignUpCode(email).catch(() => {});
            go('verify');
            return;
          }
          throw err;
        }
        done('Signed in');
      }),
      el('div', { class: 'account-links' }, linkTo('Forgot password?', 'forgot'), linkTo('Create an account', 'signup')),
    ];
  }

  function signup() {
    title.textContent = 'Create account';
    const e = emailInput();
    const p = passwordInput(`Password (at least ${MIN_PASSWORD} characters)`, 'new-password');
    return [
      el('p', { class: 'meta' }, 'Use your work email. We\'ll email you a code to confirm it\'s yours.'),
      form([e.field, p.field], 'Create account', async () => {
        email = cleanEmail(e.node.value);
        checkEmail(email);
        checkPassword(p.node.value);
        await cloud.signUp(email, p.node.value);
        go('verify');
      }),
      el('div', { class: 'account-links' }, linkTo('I already have an account', 'signin')),
    ];
  }

  function verify() {
    title.textContent = 'Confirm your email';
    const c = codeInput();
    const resend = link('Send a new code');
    resend.addEventListener('click', async () => {
      showError(null);
      try {
        await cloud.resendSignUpCode(email);
        toast('New code sent. Check your email.');
      } catch (err) { showError(err); }
    });
    return [
      el('p', { class: 'meta' }, `We emailed a code to ${email}. It can take a minute; check spam/junk too.`),
      form([c.field], 'Confirm', async () => {
        const code = c.node.value.trim();
        checkCode(code);
        await cloud.verifySignUp(email, code);
        done('Email confirmed. You\'re signed in.');
      }),
      el('div', { class: 'account-links' }, resend, linkTo('Use a different email', 'signup')),
    ];
  }

  function forgot() {
    title.textContent = 'Forgot password';
    const e = emailInput();
    return [
      el('p', { class: 'meta' }, 'We\'ll email you a code to set a new password.'),
      form([e.field], 'Email me a code', async () => {
        email = cleanEmail(e.node.value);
        checkEmail(email);
        await cloud.sendPasswordResetCode(email);
        go('reset');
      }),
      el('div', { class: 'account-links' }, linkTo('Back to sign in', 'signin')),
    ];
  }

  function reset() {
    title.textContent = 'Set a new password';
    const c = codeInput();
    const p = passwordInput(`New password (at least ${MIN_PASSWORD} characters)`, 'new-password');
    return [
      el('p', { class: 'meta' }, `If ${email} has an account, we emailed it a code.`),
      form([c.field, p.field], 'Save new password', async () => {
        const code = c.node.value.trim();
        checkCode(code);
        checkPassword(p.node.value);
        await cloud.resetPassword(email, code, p.node.value);
        done('Password changed. You\'re signed in.');
      }),
      el('div', { class: 'account-links' }, linkTo('Send a new code', 'forgot')),
    ];
  }

  function account() {
    title.textContent = 'Account';
    const out = el('button', { type: 'button', class: 'btn btn-danger account-submit' }, 'Sign out');
    out.addEventListener('click', async () => {
      try {
        await cloud.signOut();
        done('Signed out');
      } catch (err) { showError(err); }
    });
    return [
      el('div', { class: 'account-who' }, el('span', { class: 'field-label' }, 'Signed in as'), el('strong', {}, email)),
      el('p', { class: 'meta' }, 'Your projects are still saved only on this device. Syncing between devices and sharing with your team come next.'),
      errorBox,
      out,
    ];
  }

  function done(message) {
    close();
    toast(message);
    onChange();
  }

  render();
}
