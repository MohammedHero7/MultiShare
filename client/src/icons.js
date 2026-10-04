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
