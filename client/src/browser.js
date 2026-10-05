// The activity's built-in browser. Discord only lets an activity load pages from its
// own server, so websites open through /api/web, which fetches them and rewrites
// their links to come back the same way (server/src/web.js). They run sandboxed, so
// a website can't reach the activity or the watch party.

import { openExternalLink } from './session.js';
import * as ui from './ui.js';

const { $ } = ui;

// DuckDuckGo's HTML results work without JavaScript, so they open well through the
// server. Google's results need scripts that don't.
const SEARCH_URL = 'https://html.duckduckgo.com/html/?q=';

const frame = $('web-frame');
const address = $('web-url');

let token = null;
let currentUrl = '';
// The activity keeps its own history: going back inside the frame could also move
// Discord's page back.
let entries = [];
let index = -1;
let jumpTo = null;

export function setWebToken(value) {
  token = typeof value === 'string' && value ? value : null;
}

function webPath(href) {
  const url = new URL(href);
  return `/.proxy/api/web/${token}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
}

/** What someone typed in the address bar: a link, a bare domain, or words to search for. */
function addressFor(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!/\s/.test(value) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`;
  return searchUrl(value);
}

export const searchUrl = (query) => SEARCH_URL + encodeURIComponent(query);

function openOutside(url) {
  openExternalLink(url).catch(() => ui.toast("Couldn't open the website.", { tone: 'error' }));
}

/** Open a website inside the activity. */
export function openWebsite(url) {
  // Before the server has answered there's no token yet; open it outside instead.
  if (!token) {
    openOutside(url);
    return;
  }
  if (!ui.isSheetOpen('sheet-web')) ui.openSheet('sheet-web');
  navigate(url);
}

function navigate(url, { replace = false } = {}) {
  let path;
  try {
    path = webPath(url);
  } catch {
    ui.toast("That doesn't look like a web address.", { tone: 'error' });
    return;
  }
  showAddress(url);
  setLoading(true);
  if (replace && frame.contentWindow && frame.hasAttribute('src')) frame.contentWindow.location.replace(path);
  else frame.src = path;
}

function showAddress(url) {
  currentUrl = url;
  if (document.activeElement !== address) address.value = url;
}

function setLoading(loading) {
  $('web-progress').hidden = !loading;
}

function renderHistoryButtons() {
  $('web-back').disabled = index <= 0;
  $('web-forward').disabled = index >= entries.length - 1;
}

function go(step) {
  const target = index + step;
  if (target < 0 || target >= entries.length) return;
  jumpTo = target;
  navigate(entries[target], { replace: true });
}

// Each page reports its address as it opens (server/src/web-runtime.js).
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'multishare:web') return;
  const { url, title, loading } = event.data;
  if (typeof url === 'string' && url) {
    showAddress(url);
    if (jumpTo !== null && entries[jumpTo] === url) {
      index = jumpTo;
    } else if (entries[index] !== url) {
      entries = entries.slice(0, index + 1);
      entries.push(url);
      index = entries.length - 1;
    }
    jumpTo = null;
    renderHistoryButtons();
  }
  if (typeof title === 'string') frame.title = title || 'Website';
  setLoading(Boolean(loading));
});

// A page's script went to "/path" and left the browser's route (see web-runtime.js):
// open that path on the site the frame was showing.
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'multishare:web-stray') return;
  if (!currentUrl || typeof event.data.path !== 'string') return;
  try {
    navigate(new URL(event.data.path, currentUrl).href, { replace: true });
  } catch {
    // not a usable path
  }
});

frame.addEventListener('load', () => setLoading(false));

$('web-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const url = addressFor(address.value);
  if (!url) return;
  address.blur();
  navigate(url);
});
address.addEventListener('focus', () => address.select());
address.addEventListener('blur', () => {
  address.value = currentUrl;
});

$('web-back').addEventListener('click', () => go(-1));
$('web-forward').addEventListener('click', () => go(1));
$('web-reload').addEventListener('click', () => {
  if (currentUrl) navigate(currentUrl, { replace: true });
});
$('web-external').addEventListener('click', () => {
  if (currentUrl) openOutside(currentUrl);
});

// Closing the browser keeps the page for next time, but stops anything playing in it.
new MutationObserver(() => {
  if ($('sheet-web').hidden) frame.contentWindow?.postMessage({ type: 'multishare:web-command', command: 'pause' }, '*');
}).observe($('sheet-web'), { attributes: true, attributeFilter: ['hidden'] });

renderHistoryButtons();
