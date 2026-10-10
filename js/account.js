// account.js — the Account pop-up: sign in, create an account (confirmed from an email), forgot
// password, and sign out. The cloud calls live in cloud.js. The emails hold a link for now, or a
// 6-digit code once we have our own email sender (cloud.EMAIL_STYLE); both flows are here.

import * as cloud from './cloud.js';
import { el, toast } from './ui.js';
import { openCompanyPeople, openOwnerConsole } from './people.js';

const MIN_PASSWORD = 8;

const LINKS = cloud.EMAIL_STYLE === 'link';

// Opens the pop-up. onChange() runs after someone signs in or out.
// start: 'newpass' after a "Forgot password" email link signed them in.
export async function openAccountDialog({ onChange = () => {}, start = null } = {}) {
  let user = null;
  try { user = await cloud.currentUser(); } catch { /* offline and never loaded: show sign-in */ }

  let mode = start || (user ? 'account' : 'signin');
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
    const screens = { signin, signup, verify: LINKS ? emailSent : verify, forgot, reset: LINKS ? emailSent : reset, newpass, account };
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
      el('p', { class: 'meta' }, `Use your work email. We'll email you a ${LINKS ? 'link' : 'code'} to confirm it's yours.`),
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

  // Link-style emails: "check your email, tap the link, then sign in".
  function emailSent() {
    const forReset = mode === 'reset';
    title.textContent = 'Check your email';
    const resend = link(forReset ? 'Send the email again' : 'Send a new email');
    resend.addEventListener('click', async () => {
      showError(null);
      try {
        if (forReset) await cloud.sendPasswordResetCode(email);
        else await cloud.resendSignUpCode(email);
        toast('Sent. Check your email.');
      } catch (err) { showError(err); }
    });
    const signInBtn = el('button', { type: 'button', class: 'btn btn-primary account-submit' }, 'Sign in');
    signInBtn.addEventListener('click', () => go('signin'));
    return [
      el('p', { class: 'account-big' }, forReset
        ? `If ${email} has an account, we sent it an email with a link to set a new password.`
        : `We sent an email to ${email}. Tap "Confirm email address" in it.`),
      el('p', { class: 'meta' }, forReset
        ? 'The link opens Scope Optimized, where you choose the new password. It can take a minute to arrive; check spam/junk too.'
        : 'Then come back and sign in. It can take a minute to arrive; check spam/junk too. If you use Scope Optimized from your home screen, the link may open in your browser instead. That\'s fine: your email is confirmed either way.'),
      forReset ? null : signInBtn,
      errorBox,
      el('div', { class: 'account-links' }, resend, linkTo(forReset ? 'Back to sign in' : 'Use a different email', forReset ? 'signin' : 'signup')),
    ].filter(Boolean);
  }

  // Set a new password after a "Forgot password" link signed them in.
  function newpass() {
    title.textContent = 'Set a new password';
    const p = passwordInput(`New password (at least ${MIN_PASSWORD} characters)`, 'new-password');
    return [
      el('p', { class: 'meta' }, 'Choose a new password for your account.'),
      form([p.field], 'Save new password', async () => {
        checkPassword(p.node.value);
        await cloud.setNewPassword(p.node.value);
        done('Password changed. You\'re signed in.');
      }),
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
      el('p', { class: 'meta' }, LINKS ? 'We\'ll email you a link to set a new password.' : 'We\'ll email you a code to set a new password.'),
      form([e.field], LINKS ? 'Email me a link' : 'Email me a code', async () => {
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
    const details = el('div', { class: 'account-details' }, el('p', { class: 'meta' }, 'Loading your account…'));
    loadDetails(details);
    return [
      el('div', { class: 'account-who' }, el('span', { class: 'field-label' }, 'Signed in as'), el('strong', {}, email)),
      details,
      el('p', { class: 'meta' }, 'Your projects are still saved only on this device. Syncing between devices and sharing with your team come next.'),
      errorBox,
      out,
    ];
  }

  // Name + company, from the database (needs signal).
  async function loadDetails(box) {
    let info;
    let access;
    try {
      [info, access] = await Promise.all([cloud.myAccount(), cloud.myAccess()]);
    } catch (err) {
      box.replaceChildren(el('p', { class: 'meta' }, `Couldn't load your company details: ${err.message}`));
      return;
    }
    if (!box.isConnected || !info) return;
    access = access || {};

    // Your name (shown to people on your projects).
    const nameInput = el('input', {
      class: 'account-input', type: 'text', value: info.fullName, placeholder: 'First and last name',
      autocomplete: 'name', maxlength: '120',
    });
    let savedName = info.fullName;
    const saveName = async () => {
      const v = nameInput.value.trim();
      if (v === savedName) return;
      try {
        await cloud.setMyName(v);
        savedName = v;
        toast('Name saved');
      } catch (err) { showError(err); }
    };
    nameInput.addEventListener('change', saveName);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });

    box.replaceChildren(...[
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Your name'), nameInput,
        el('span', { class: 'field-hint' }, 'Shown to people on your projects.')),
      companySection(info, access),
      access.is_owner ? el('button', {
        type: 'button', class: 'btn account-submit',
        onclick: () => { close(); openOwnerConsole(); },
      }, 'App owner: companies & requests') : null,
    ].filter(Boolean));
  }

  function companySection(info, access) {
    const domain = cloud.emailDomain(info.email);
    const personal = cloud.isPublicEmailDomain(domain);
    const c = access.company;
    if (c) {
      const admin = access.company_role === 'admin';
      return el('div', { class: 'account-company' },
        el('span', { class: 'field-label' }, 'Company'),
        el('strong', {}, c.name),
        el('span', { class: 'meta' }, admin ? 'You\'re an admin: you see and manage all of its projects.' : 'Member: you see the projects you\'re added to.'),
        c.domain && !c.invite_only ? el('span', { class: 'meta' }, `Anyone who signs up with an @${c.domain} email joins automatically.`) : null,
        c.invite_only ? el('span', { class: 'meta' }, 'Invite-only: people join when an admin adds them.') : null,
        admin ? el('button', { type: 'button', class: 'btn account-submit', onclick: () => { close(); openCompanyPeople(); } }, 'Manage people') : null);
    }
    if (access.pending_request) {
      const cancel = el('button', { type: 'button', class: 'link-btn dark' }, 'Cancel request');
      cancel.addEventListener('click', async () => {
        try { await cloud.cancelCompanyRequest(); render(); } catch (err) { showError(err); }
      });
      return el('div', { class: 'account-company' },
        el('span', { class: 'field-label' }, 'Company'),
        el('strong', {}, `${access.pending_request} (requested)`),
        el('span', { class: 'meta' }, 'Your request to set up this company is waiting for approval. You\'ll become its admin once it\'s approved.'),
        el('div', {}, cancel));
    }
    const ask = el('button', { type: 'button', class: 'btn account-submit' }, 'Request your company');
    ask.addEventListener('click', async () => {
      const name = (window.prompt('Your company\'s name (e.g. ABC Builders)') || '').trim();
      if (!name) return;
      showError(null);
      ask.disabled = true;
      try {
        await cloud.requestCompany(name);
        toast('Request sent. You\'ll be set up as soon as it\'s approved.', 4000);
        render();
      } catch (err) {
        showError(err);
        ask.disabled = false;
      }
    });
    return el('div', { class: 'account-company' },
      el('span', { class: 'field-label' }, 'Company'),
      el('span', {}, 'You\'re not part of a company yet.'),
      el('span', { class: 'meta' }, personal
        ? `Your email is a personal address (@${domain}). Co-workers usually sign up with their work email; a company set up from this account would be invite-only.`
        : `If your company were already set up here, you'd have joined automatically. You can request it: once approved, you'll be its admin and anyone signing up with an @${domain} email joins it.`),
      el('span', { class: 'meta' }, 'Projects you share with others (they\'re added by email) work without a company too.'),
      ask);
  }

  function done(message) {
    close();
    toast(message);
    onChange();
  }

  render();
}
