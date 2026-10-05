export function formatTime(totalSeconds) {
  const value = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const seconds = Math.floor(value % 60);
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** "Sara", "Sara and Omar", "Sara, Omar and 3 others" */
export function joinNames(names, max = 2) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= max + 1) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} and ${rest} others`;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** 36719807 → "36.7M views" */
export const formatViews = (count) => `${compact.format(count)} ${count === 1 ? 'view' : 'views'}`;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
const AGO_UNITS = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** A Unix time in seconds → "3 years ago" */
export function formatAgo(seconds) {
  const elapsed = Date.now() / 1000 - seconds;
  if (!(elapsed >= 0)) return '';
  const [unit, size] = AGO_UNITS.find(([, length]) => elapsed >= length) ?? ['minute', 60];
  return relative.format(-Math.max(1, Math.floor(elapsed / size)), unit);
}
