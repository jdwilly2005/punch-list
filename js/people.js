// people.js — who can see what:
//   • openProjectPeople(project)  — a project's people: add by email with a role, change, remove
//   • openCompanyPeople()         — company admins: everyone in the company, invites, invite-only
//   • openOwnerConsole()          — the app owner (JD): approve company requests, add companies
// The rules themselves are enforced by the database (supabase/008_people_and_invites.sql); these
// screens just call it and show plain-English results.

import * as cloud from './cloud.js';
import { el, toast, choose } from './ui.js';

export const ROLE_INFO = {
  manager: { label: 'Manager', note: 'Edits everything and manages who\'s on the project' },
  editor: { label: 'Editor', note: 'Adds and edits items, sheets and photos' },
  viewer: { label: 'Viewer', note: 'Sees everything, can\'t change anything (owners, architects)' },
  trade: { label: 'Trade', note: 'Sees only the items for their trade(s), read-only (subs)' },
};

// ---------- A pop-up sheet with a title, a body, and a Done button ----------

function sheet(title) {
  const body = el('div', { class: 'pl-sheet-body people-body' });
  const layer = el('div', { class: 'pl-layer' },
    el('div', { class: 'pl-sheet', role: 'dialog', 'aria-label': title },
      el('div', { class: 'pl-sheet-head' },
        el('span', { class: 'head-spacer' }),
        el('h2', {}, title),
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => layer.remove() }, 'Done')),
      body));
  document.body.append(layer);
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  return {
    body,
    close: () => layer.remove(),
    isOpen: () => layer.isConnected,
    errorBox,
    showError(err) {
      errorBox.textContent = err ? err.message || String(err) : '';
      errorBox.hidden = !err;
    },
  };
}

const personLabel = (p) => (p.full_name ? `${p.full_name}` : p.email);
const roleText = (p) => {
  const base = ROLE_INFO[p.role]?.label || p.role;
  const trades = p.role === 'trade' && p.trades?.length ? `: ${p.trades.join(', ')}` : '';
  return `${base}${trades}`;
};

// After adding someone who has no account yet: nothing is emailed automatically (yet), so offer
// to send them the sign-up link.
async function shareSignupLink(email, what) {
  const text = `You've been added to ${what} in Punch List. Sign up at ${cloud.APP_LINK} using ${email} and it'll be there.`;
  const canShare = !!navigator.share;
  const pick = await choose({
    title: `${email} doesn't have an account yet`,
    message: `They're on the list: as soon as they sign up with ${email} (and confirm it), they'll have access. Punch List doesn't email invitations yet, so send them the link:`,
    choices: [
      canShare ? { label: 'Send the sign-up link…', value: 'share', kind: 'primary', note: 'Text, email, Teams…' } : null,
      { label: 'Copy the message', value: 'copy', kind: canShare ? undefined : 'primary' },
    ].filter(Boolean),
  });
  if (pick === 'share') navigator.share({ text }).catch(() => {});
  if (pick === 'copy') {
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into a text or email.'); } catch { window.prompt('Copy this message:', text); }
  }
}

// ---------- Project people ----------

// project: the device's project record. Only works once the project has uploaded.
// As a pop-up (from the project's ⋯ menu on the Projects screen):
export async function openProjectPeople(project) {
  await projectPeopleInto(sheet(`People · ${project.name}`), project);
}

// As the People tab inside a project: { node, render(project) }.
export function createPeopleTab() {
  const body = el('div', { class: 'people-tab-inner' });
  const errorBox = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const s = {
    body,
    errorBox,
    isOpen: () => body.isConnected,
    showError(err) {
      errorBox.textContent = err ? err.message || String(err) : '';
      errorBox.hidden = !err;
    },
  };
  return {
    node: el('div', { class: 'people-tab' }, body),
    render: (project) => projectPeopleInto(s, project),
  };
}

async function projectPeopleInto(s, project) {
  let user = null;
  try { user = await cloud.currentUser(); } catch { /* offline */ }
  if (!user) {
    s.body.replaceChildren(el('p', {}, 'Sign in (person icon, top right) to share projects with your team.'));
    return;
  }
  if (!project.cloud) {
    s.body.replaceChildren(el('p', {}, 'This project hasn\'t finished uploading yet. Once it has synced (see the line under "Projects"), you can add people.'));
    return;
  }
  s.body.replaceChildren(el('p', { class: 'meta' }, 'Loading…'));
  await load();

  async function load() {
    let people;
    try {
      people = await cloud.projectPeople(project.id);
    } catch (err) {
      s.body.replaceChildren(el('p', { class: 'form-error' }, err.message));
      return;
    }
    if (!s.isOpen()) return;
    const me = people.find((p) => p.user_id === user.id);
    const canManage = me && me.role === 'manager';

    const rows = people.map((p) => {
      const fixed = p.kind === 'owner' || p.kind === 'company admin';
      const tag = p.kind === 'owner' ? 'Owner' : p.kind === 'company admin' ? 'Company admin' : roleText(p);
      const row = el(canManage && !fixed ? 'button' : 'div', { type: canManage && !fixed ? 'button' : null, class: 'person-row' },
        el('span', { class: 'person-main' },
          el('strong', {}, personLabel(p) + (p.user_id === user.id ? ' (you)' : '')),
          p.full_name ? el('small', {}, p.email) : null),
        el('span', { class: `person-role${p.kind === 'invited' ? ' invited' : ''}` },
          p.kind === 'invited' ? `Invited · ${tag}` : tag));
      if (canManage && !fixed) row.addEventListener('click', () => personMenu(p));
      return row;
    });

    s.body.replaceChildren(...[
      el('div', { class: 'people-list' }, rows),
      canManage ? addForm() : el('p', { class: 'meta' }, 'Only the project\'s managers can add or remove people.'),
      s.errorBox,
      el('details', { class: 'role-help' }, el('summary', {}, 'What the roles mean'),
        el('ul', {}, Object.values(ROLE_INFO).map((r) => el('li', {}, el('strong', {}, r.label), ` — ${r.note}`)),
          el('li', {}, el('strong', {}, 'Company admins'), ' manage every project of their company automatically.'))),
    ].filter(Boolean));
  }

  async function personMenu(p) {
    const choice = await choose({
      title: personLabel(p),
      message: p.kind === 'invited' ? `Invited as ${roleText(p)}; hasn't signed up yet.` : `${roleText(p)}`,
      choices: [
        ...Object.entries(ROLE_INFO).filter(([k]) => k !== p.role || k === 'trade')
          .map(([k, r]) => ({ label: k === p.role ? 'Change trades…' : `Make ${r.label}`, value: k, note: r.note })),
        { label: p.kind === 'invited' ? 'Cancel invitation' : 'Remove from project', value: 'remove', kind: 'danger' },
      ],
    });
    if (!choice) return;
    s.showError(null);
    try {
      if (choice === 'remove') {
        await cloud.projectRemovePerson(project.id, p.email);
        toast(`${personLabel(p)} removed`);
      } else {
        const trades = choice === 'trade' ? await pickTrades(p.trades || []) : [];
        if (trades === null) return;
        await cloud.projectAddPerson(project.id, p.email, choice, trades);
        toast(`${personLabel(p)} is now ${choice === 'trade' ? `Trade: ${trades.join(', ')}` : ROLE_INFO[choice].label}`);
      }
      await load();
    } catch (err) { s.showError(err); }
  }

  // Which trades a "trade" person sees (from the project's trade list).
  async function pickTrades(selected) {
    const list = project.trades || [];
    if (!list.length) {
      const typed = (window.prompt('Which trade should they see? (Add trades to the project to pick from a list.)') || '').trim();
      return typed ? [typed] : null;
    }
    return new Promise((resolve) => {
      const chosen = new Set(selected);
      const chips = el('div', { class: 'trade-chips' }, list.map((t) => {
        const b = el('button', { type: 'button', class: 'trade-chip', 'aria-pressed': String(chosen.has(t)) }, t);
        b.addEventListener('click', () => {
          if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
          b.setAttribute('aria-pressed', String(chosen.has(t)));
        });
        return b;
      }));
      const ok = el('button', { type: 'button', class: 'btn btn-primary account-submit' }, 'Done');
      const layer = el('div', { class: 'pl-layer' },
        el('div', { class: 'pl-sheet pl-choose', role: 'dialog', 'aria-label': 'Pick trades' },
          el('div', { class: 'pl-sheet-body' },
            el('h2', { class: 'choose-title' }, 'Which trades do they see?'),
            el('p', { class: 'choose-message' }, 'They\'ll see only items assigned to these trades.'),
            chips, ok,
            el('button', { type: 'button', class: 'btn btn-ghost choose-btn', onclick: () => { layer.remove(); resolve(null); } }, 'Cancel'))));
      ok.addEventListener('click', () => {
        if (!chosen.size) { toast('Pick at least one trade.'); return; }
        layer.remove();
        resolve([...chosen]);
      });
      document.body.append(layer);
    });
  }

  function addForm() {
    const email = el('input', { class: 'account-input', type: 'email', placeholder: 'name@company.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const role = el('select', { class: 'account-input' },
      Object.entries(ROLE_INFO).map(([k, r]) => el('option', { value: k }, `${r.label} — ${r.note}`)));
    role.value = 'editor';
    const add = el('button', { type: 'submit', class: 'btn btn-primary account-submit' }, 'Add person');
    const f = el('form', { class: 'account-form people-add' },
      el('h3', { class: 'people-subtitle' }, 'Add someone'),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Email'), email),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Role'), role),
      add);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      s.showError(null);
      const addr = email.value.trim().toLowerCase();
      if (!addr) { email.focus(); return; }
      const trades = role.value === 'trade' ? await pickTrades([]) : [];
      if (trades === null) return;
      add.disabled = true;
      try {
        const result = await cloud.projectAddPerson(project.id, addr, role.value, trades);
        email.value = '';
        await load();
        if (result === 'invited') await shareSignupLink(addr, `the project "${project.name}"`);
        else toast(`${addr} added. They'll see the project next time their app syncs.`, 4000);
      } catch (err) {
        s.showError(err);
      } finally {
        add.disabled = false;
      }
    });
    return f;
  }
}

// ---------- Company people (admins) ----------

export async function openCompanyPeople() {
  const s = sheet('Company people');
  s.body.replaceChildren(el('p', { class: 'meta' }, 'Loading…'));
  let user = null;
  try { user = await cloud.currentUser(); } catch { /* offline */ }
  await load();

  async function load() {
    let access;
    let people;
    try {
      [access, people] = await Promise.all([cloud.myAccess(), cloud.companyPeople()]);
    } catch (err) {
      s.body.replaceChildren(el('p', { class: 'form-error' }, err.message));
      return;
    }
    if (!s.isOpen()) return;
    const c = access.company;
    const isAdmin = access.company_role === 'admin';

    const rows = people.map((p) => {
      const row = el(isAdmin ? 'button' : 'div', { type: isAdmin ? 'button' : null, class: 'person-row' },
        el('span', { class: 'person-main' },
          el('strong', {}, personLabel(p) + (p.user_id && user && p.user_id === user.id ? ' (you)' : '')),
          p.full_name ? el('small', {}, p.email) : null),
        el('span', { class: `person-role${p.pending ? ' invited' : ''}` },
          `${p.pending ? 'Invited · ' : ''}${p.company_role === 'admin' ? 'Admin' : 'Member'}`));
      if (isAdmin) row.addEventListener('click', () => personMenu(p));
      return row;
    });

    const inviteOnly = el('input', { type: 'checkbox', checked: !!c.invite_only, disabled: !isAdmin });
    inviteOnly.addEventListener('change', async () => {
      try {
        await cloud.companySetInviteOnly(inviteOnly.checked);
        toast(inviteOnly.checked ? 'Invite-only: people join only when an admin adds them' : `Anyone with an @${c.domain} email can join`);
      } catch (err) { s.showError(err); inviteOnly.checked = !inviteOnly.checked; }
    });

    s.body.replaceChildren(...[
      el('p', { class: 'meta' }, `${c.name}${c.domain ? ` · @${c.domain}` : ''}. Admins see and manage every company project; members see the projects they're added to.`),
      el('div', { class: 'people-list' }, rows),
      isAdmin ? inviteForm() : null,
      c.domain ? el('label', { class: 'check-row' }, inviteOnly,
        el('span', {}, el('strong', {}, 'Invite-only'),
          el('small', {}, ` Off: anyone who signs up with an @${c.domain} email joins automatically. On: only people an admin adds.`))) : null,
      s.errorBox,
    ].filter(Boolean));
  }

  async function personMenu(p) {
    const you = user && p.user_id === user.id;
    const choices = p.pending
      ? [{ label: 'Cancel invitation', value: 'cancel', kind: 'danger' }]
      : [
        p.company_role === 'admin'
          ? { label: 'Make member', value: 'member', note: 'Sees only projects they\'re added to' }
          : { label: 'Make admin', value: 'admin', note: 'Sees and manages every company project' },
        you ? null : { label: 'Remove from company', value: 'remove', kind: 'danger', note: 'They lose every company project at once; projects they own pass to you' },
      ].filter(Boolean);
    const choice = await choose({ title: personLabel(p), message: p.email, choices });
    if (!choice) return;
    s.showError(null);
    try {
      if (choice === 'cancel') await cloud.companyCancelInvite(p.email);
      else if (choice === 'remove') {
        const sure = await choose({
          title: `Remove ${personLabel(p)}?`,
          message: 'They\'ll lose access to all company projects right away. Projects they own pass to you. Their own account stays (they just leave the company).',
          choices: [{ label: 'Remove from company', value: 'yes', kind: 'danger' }],
        });
        if (sure !== 'yes') return;
        await cloud.companyRemove(p.user_id);
        toast(`${personLabel(p)} removed from the company`);
      } else {
        await cloud.companySetRole(p.user_id, choice);
        toast(`${personLabel(p)} is now ${choice === 'admin' ? 'an admin' : 'a member'}`);
      }
      await load();
    } catch (err) { s.showError(err); }
  }

  function inviteForm() {
    const email = el('input', { class: 'account-input', type: 'email', placeholder: 'name@company.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const role = el('select', { class: 'account-input' },
      el('option', { value: 'member' }, 'Member — sees projects they\'re added to'),
      el('option', { value: 'admin' }, 'Admin — sees and manages every company project'));
    const add = el('button', { type: 'submit', class: 'btn btn-primary account-submit' }, 'Add to company');
    const f = el('form', { class: 'account-form people-add' },
      el('h3', { class: 'people-subtitle' }, 'Add someone to the company'),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Email'), email),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Role'), role),
      add);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      s.showError(null);
      const addr = email.value.trim().toLowerCase();
      if (!addr) { email.focus(); return; }
      add.disabled = true;
      try {
        const result = await cloud.companyInvite(addr, role.value);
        email.value = '';
        await load();
        if (result === 'invited') await shareSignupLink(addr, 'your company');
        else toast(`${addr} added to the company`);
      } catch (err) {
        s.showError(err);
      } finally {
        add.disabled = false;
      }
    });
    return f;
  }
}

// ---------- App owner console (JD) ----------

export async function openOwnerConsole() {
  const s = sheet('App owner');
  s.body.replaceChildren(el('p', { class: 'meta' }, 'Loading…'));
  await load();

  async function load() {
    let requests;
    let companies;
    try {
      [requests, companies] = await Promise.all([cloud.ownerListRequests(), cloud.ownerListCompanies()]);
    } catch (err) {
      s.body.replaceChildren(el('p', { class: 'form-error' }, err.message));
      return;
    }
    if (!s.isOpen()) return;
    const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    const requestRows = requests.map((r) => el('div', { class: 'owner-request' },
      el('span', { class: 'person-main' },
        el('strong', {}, r.company_name),
        el('small', {}, `${r.email} · ${r.domain ? `@${r.domain} joins automatically` : 'invite-only (personal email)'} · ${when(r.created_at)}`)),
      el('span', { class: 'owner-actions' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => decide(r, false) }, 'Decline'),
        el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => decide(r, true) }, 'Approve'))));

    const companyRows = companies.map((c) => el('div', { class: 'person-row' },
      el('span', { class: 'person-main' },
        el('strong', {}, c.name),
        el('small', {}, [c.domain ? `@${c.domain}${c.invite_only ? ' (invite-only)' : ''}` : 'no domain', `${c.people} ${c.people === 1 ? 'person' : 'people'}`,
          `${c.projects} project${c.projects === 1 ? '' : 's'}`, c.admins ? `admin: ${c.admins}` : 'admin invited'].join(' · '))),
      el('span', { class: 'person-role' }, when(c.created_at))));

    s.body.replaceChildren(...[
      el('h3', { class: 'people-subtitle' }, `Requests waiting (${requests.length})`),
      requests.length ? el('div', { class: 'people-list' }, requestRows) : el('p', { class: 'meta' }, 'No requests right now.'),
      el('h3', { class: 'people-subtitle' }, `Companies (${companies.length})`),
      companies.length ? el('div', { class: 'people-list' }, companyRows) : el('p', { class: 'meta' }, 'No companies yet.'),
      addCompanyForm(),
      s.errorBox,
    ]);
  }

  async function decide(r, approve) {
    s.showError(null);
    try {
      await cloud.ownerDecideRequest(r.id, approve);
      toast(approve ? `${r.company_name} approved. ${r.email} is its admin.` : `Request from ${r.email} declined`, 4000);
      await load();
    } catch (err) { s.showError(err); }
  }

  function addCompanyForm() {
    const name = el('input', { class: 'account-input', type: 'text', placeholder: 'ABC Builders', autocomplete: 'off' });
    const domain = el('input', { class: 'account-input', type: 'text', placeholder: 'abcbuilders.com (optional)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const admin = el('input', { class: 'account-input', type: 'email', placeholder: 'pm@abcbuilders.com', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const add = el('button', { type: 'submit', class: 'btn btn-primary account-submit' }, 'Add company');
    const f = el('form', { class: 'account-form people-add' },
      el('h3', { class: 'people-subtitle' }, 'Add a company'),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Company name'), name),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Email domain'), domain,
        el('span', { class: 'field-hint' }, 'People who sign up with this email domain join automatically. Leave blank for invite-only.')),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'First admin\'s email'), admin),
      add);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      s.showError(null);
      add.disabled = true;
      try {
        const addr = admin.value.trim().toLowerCase();
        const result = await cloud.ownerCreateCompany(name.value.trim(), domain.value.trim(), addr);
        const companyName = name.value.trim();
        name.value = domain.value = admin.value = '';
        await load();
        if (result === 'invited') await shareSignupLink(addr, `${companyName} (as its admin)`);
        else toast(`${companyName} added. ${addr} is its admin.`, 4000);
      } catch (err) {
        s.showError(err);
      } finally {
        add.disabled = false;
      }
    });
    return f;
  }
}
