const stroke = (paths) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1" fill="currentColor"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1" fill="currentColor"/></svg>',
  replay: stroke('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/>'),
  volume: stroke('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  muted: stroke('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5"/><path d="M21 9.5l-5 5"/>'),
  fullscreen: stroke('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  'fullscreen-exit': stroke('<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>'),
  subtitles: stroke('<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M7 12.5h3.5"/><path d="M13 12.5h4"/><path d="M7 15.5h7"/>'),
  film: stroke('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 4v16"/><path d="M16.5 4v16"/><path d="M3 9h4.5"/><path d="M3 15h4.5"/><path d="M16.5 9H21"/><path d="M16.5 15H21"/>'),
  close: stroke('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  upload: stroke('<path d="M12 15.5V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M5 19.5h14"/>'),
  link: stroke('<path d="M10 14a4.2 4.2 0 0 0 6 0l3.2-3.2a4.2 4.2 0 0 0-6-6L12 6"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3.2 3.2a4.2 4.2 0 0 0 6 6L12 18"/>'),
  folder: stroke('<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  back: stroke('<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>'),
  forward: stroke('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>'),
  reload: stroke('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v4h-4"/>'),
  external: stroke('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  search: stroke('<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.5 15.5l4.5 4.5"/>'),
  youtube:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M21.6 7.4a2.6 2.6 0 0 0-1.8-1.9C18.2 5 12 5 12 5s-6.2 0-7.8.5a2.6 2.6 0 0 0-1.8 1.9C2 9 2 12 2 12s0 3 .4 4.6a2.6 2.6 0 0 0 1.8 1.9C5.8 19 12 19 12 19s6.2 0 7.8-.5a2.6 2.6 0 0 0 1.8-1.9C22 15 22 12 22 12s0-3-.4-4.6zM10 15.1V8.9l5.3 3.1z"/></svg>',
};

export function icon(name) {
  return ICONS[name] ?? '';
}

/** Fill every <span data-icon="name"> inside root. */
export function hydrateIcons(root = document) {
  for (const element of root.querySelectorAll('[data-icon]')) {
    element.innerHTML = icon(element.dataset.icon);
  }
}

export function setIcon(element, name) {
  const slot = element.matches('[data-icon]') ? element : element.querySelector('[data-icon]');
  if (slot && slot.dataset.icon !== name) {
    slot.dataset.icon = name;
    slot.innerHTML = icon(name);
  }
}
