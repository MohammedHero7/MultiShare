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
