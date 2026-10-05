export const $ = (id) => document.getElementById(id);

const app = $('app');

/* ---------- Toasts ---------- */

export function toast(text, { tone = 'info', duration = 3200 } = {}) {
  const container = $('toasts');
  const element = document.createElement('div');
  element.className = `pill toast toast--${tone}`;
  element.textContent = text;
  container.append(element);
  while (container.children.length > 3) container.firstElementChild.remove();
  setTimeout(() => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 300);
  }, duration);
}

export function setStatus(text) {
  const element = $('status');
  element.hidden = !text;
  element.textContent = text || '';
}

/* ---------- Splash (connecting / fatal errors) ---------- */

// The film-leader sweep is the loading indicator: one copy on the splash while
// connecting, one over the picture while the video buffers.
const splashLeader = $('leader').cloneNode(true);
splashLeader.removeAttribute('id');
splashLeader.classList.add('leader--inline');
$('splash').prepend(splashLeader);

export function showSplash(title, text = '', { retry = false, waiting = true } = {}) {
  $('splash').hidden = false;
  $('splash-title').textContent = title;
  $('splash-text').textContent = text;
  $('splash-retry').hidden = !retry;
  splashLeader.hidden = !waiting;
}

export function hideSplash() {
  $('splash').hidden = true;
}

let buffering = false;
export function setBuffering(value) {
  if (!$('media-iframe')?.hidden) value = false;
  if (buffering === value) return;
  buffering = value;
  $('leader').hidden = !value;
}

/* ---------- Viewers ---------- */

export function renderViewers(users, meId) {
  const container = $('viewers');
  const shown = users.slice(0, 5);
  const avatars = shown.map((user) => {
    const element = document.createElement(user.avatar ? 'img' : 'span');
    element.className = 'viewers__avatar';
    element.title = user.id === meId ? `${user.name} (you)` : user.name;
    if (user.avatar) {
      element.src = user.avatar;
      element.alt = '';
      element.referrerPolicy = 'no-referrer';
    } else {
      element.textContent = user.name.trim().charAt(0).toUpperCase() || '?';
    }
    return element;
  });
  if (users.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'viewers__avatar viewers__avatar--more';
    more.textContent = `+${users.length - shown.length}`;
    avatars.push(more);
  }
  container.replaceChildren(...avatars);
  container.setAttribute('aria-label', `${users.length} watching: ${users.map((u) => u.name).join(', ')}`);
}

/* ---------- Sheets ---------- */

let openSheetId = null;
let returnFocus = null;

export function openSheet(id) {
  if (openSheetId) closeSheet();
  const sheet = $(id);
  returnFocus = document.activeElement;
  sheet.hidden = false;
  openSheetId = id;
  app.classList.add('has-sheet');
  const focusTarget = sheet.querySelector('.tabpanel:not([hidden]) input, input:not([type=checkbox]):not([hidden]), button');
  requestAnimationFrame(() => focusTarget?.focus());
}

export function closeSheet() {
  if (!openSheetId) return;
  $(openSheetId).hidden = true;
  openSheetId = null;
  app.classList.remove('has-sheet');
  if (returnFocus?.isConnected) returnFocus.focus();
}

export const isSheetOpen = (id) => (id ? openSheetId === id : Boolean(openSheetId));

for (const sheet of document.querySelectorAll('.sheet')) {
  sheet.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closeSheet();
  });
}

export function selectTab(sheetId, name) {
  const sheet = $(sheetId);
  for (const tab of sheet.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of sheet.querySelectorAll('.tabpanel')) panel.hidden = panel.dataset.panel !== name;
}

/* ---------- Auto-hiding controls ---------- */

let idleTimer = null;
let pointerOverChrome = false;
let tabbing = false; // true while someone moves through the controls with Tab
let canIdle = () => false;

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') tabbing = true;
});
document.addEventListener('pointerdown', () => {
  tabbing = false;
});

export function setIdlePolicy(fn) {
  canIdle = fn;
}

export function wake() {
  app.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const tabbingInChrome = tabbing && document.activeElement?.closest?.('.controls, .topbar');
    if (canIdle() && !pointerOverChrome && !openSheetId && !tabbingInChrome) {
      app.classList.add('is-idle');
    }
  }, 2800);
}

export function sleep() {
  clearTimeout(idleTimer);
  if (canIdle() && !openSheetId) app.classList.add('is-idle');
}

export const isIdle = () => app.classList.contains('is-idle');

for (const id of ['controls', 'topbar']) {
  $(id).addEventListener('pointerenter', () => {
    pointerOverChrome = true;
  });
  $(id).addEventListener('pointerleave', () => {
    pointerOverChrome = false;
  });
}

/* ---------- Form errors ---------- */

export function setFieldError(id, message) {
  const element = $(id);
  element.textContent = message || '';
  element.hidden = !message;
}

export function setBusy(button, busy, busyLabel = 'Loading…') {
  if (busy) {
    button.dataset.label ??= button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}
