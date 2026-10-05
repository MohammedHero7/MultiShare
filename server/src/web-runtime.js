// Runs in the browser, not on the server: web.js adds it to the top of every website
// opened in the activity's browser, so it runs before the site's own scripts.
//
// The server already pointed the page's links at /api/web. This does the same for
// whatever the site's scripts load or open later, stands in for cookies and storage
// (a sandboxed page has neither), and tells the activity which address is open.
(() => {
  const PROXY_PATH = /^(?:\/\.proxy)?\/api\/web\/([\w.-]+)\/(https?)\/([^/?#]+)(.*)$/;
  const current = PROXY_PATH.exec(location.pathname);
  if (!current) {
    // A script went to "/path" with location.href, which leaves this route. The server
    // answers with this script alone; the activity knows which site the frame was on.
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'multishare:web-stray', path: location.pathname + location.search + location.hash }, '*');
    }
    return;
  }
  const prefix = `/.proxy/api/web/${current[1]}/`;
  const script = document.currentScript;

  /** The website address behind a link to this server, or null. */
  const realUrl = (href) => {
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    const match = url.host === location.host && PROXY_PATH.exec(url.pathname + url.search + url.hash);
    if (!match) return null;
    const rest = match[4].startsWith('/') ? match[4] : `/${match[4]}`;
    // __mpref names the page a link was on (see web.js); it isn't part of the address.
    return `${match[2]}://${match[3]}${rest}`.replace(/([?&])__mpref=[^&#]*&?/, '$1').replace(/[?&](#|$)/, '$1');
  };
  const pageOrigin = new URL(realUrl(location.href)).origin;

  const SKIP = /^(#|javascript:|data:|blob:|about:|mailto:|tel:|sms:)/i;

  /** Point a URL the site uses at this server. Links that already are stay as they are. */
  const proxify = (value) => {
    if (value == null) return value;
    const text = String(value).trim();
    if (!text || SKIP.test(text)) return value;
    let url;
    try {
      url = new URL(text, document.baseURI);
      if (url.host === location.host) {
        // Relative to the proxied page: already fine.
        if (PROXY_PATH.test(url.pathname)) return value;
        // "/path" means the website's root, not this server's.
        url = new URL(url.pathname + url.search + url.hash, realUrl(document.baseURI) || realUrl(location.href));
      }
    } catch {
      return value;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    let { search } = url;
    if (url.origin !== pageOrigin) search = `${search || '?'}${search.length > 1 ? '&' : ''}__mpref=${encodeURIComponent(pageOrigin)}`;
    return `${prefix}${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${search}${url.hash}`;
  };

  // Same splitting as the server's rewriteSrcset.
  const proxifySrcset = (value) => {
    const text = String(value);
    const candidates = [];
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i += 1;
      if (i >= text.length) break;
      let end = i;
      while (end < text.length && !/\s/.test(text[end])) end += 1;
      let url = text.slice(i, end);
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        const comma = text.indexOf(',', end);
        const stop = comma === -1 ? text.length : comma;
        descriptor = text.slice(end, stop).trim();
        end = stop;
      }
      candidates.push(descriptor ? `${proxify(url)} ${descriptor}` : proxify(url));
      i = end + 1;
    }
    return candidates.join(', ');
  };

  // New tabs and windows can't open from the activity; open links in place.
  const sameFrame = (value) => (/^\s*_(blank|top|parent|new)\s*$/i.test(String(value)) ? '_self' : value);

  /* ---------- Requests the site's scripts make ---------- */

  const nativeFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    if (input instanceof Request) {
      const fixed = proxify(input.url);
      if (fixed !== input.url) {
        try {
          input = new Request(fixed, input);
        } catch {
          // keep the original request
        }
      }
    } else {
      input = proxify(input);
    }
    return nativeFetch.call(this, input, init);
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    return nativeXhrOpen.call(this, method, proxify(url), ...rest);
  };

  const nativeBeacon = navigator.sendBeacon?.bind(navigator);
  if (nativeBeacon) navigator.sendBeacon = (url, data) => nativeBeacon(proxify(url), data);

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = class EventSource extends NativeEventSource {
      constructor(url, options) {
        super(proxify(url), options);
      }
    };
  }

  const nativeWindowOpen = window.open;
  window.open = function open(url, ...rest) {
    return nativeWindowOpen.call(this, url ? proxify(url) : url, ...rest);
  };

  for (const name of ['pushState', 'replaceState']) {
    const native = history[name];
    history[name] = function (state, title, url) {
      const result = url == null ? native.call(this, state, title) : native.call(this, state, title, proxify(url));
      report(false);
      return result;
    };
  }

  /* ---------- Links the site's scripts set on elements ---------- */

  const patchProperty = (type, name, map) => {
    const descriptor = type && Object.getOwnPropertyDescriptor(type.prototype, name);
    if (!descriptor?.set) return;
    Object.defineProperty(type.prototype, name, {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, map(value));
      },
    });
  };

  for (const [type, names] of [
    [window.HTMLAnchorElement, ['href']],
    [window.HTMLAreaElement, ['href']],
    [window.HTMLLinkElement, ['href']],
    [window.HTMLBaseElement, ['href']],
    [window.HTMLImageElement, ['src']],
    [window.HTMLScriptElement, ['src']],
    [window.HTMLIFrameElement, ['src']],
    [window.HTMLEmbedElement, ['src']],
    [window.HTMLMediaElement, ['src']],
    [window.HTMLSourceElement, ['src']],
    [window.HTMLTrackElement, ['src']],
    [window.HTMLInputElement, ['src', 'formAction']],
    [window.HTMLButtonElement, ['formAction']],
    [window.HTMLFormElement, ['action']],
    [window.HTMLVideoElement, ['poster']],
    [window.HTMLObjectElement, ['data']],
  ]) {
    for (const name of names) patchProperty(type, name, proxify);
  }
  patchProperty(window.HTMLImageElement, 'srcset', proxifySrcset);
  patchProperty(window.HTMLSourceElement, 'srcset', proxifySrcset);
  patchProperty(window.HTMLAnchorElement, 'target', sameFrame);
  patchProperty(window.HTMLFormElement, 'target', sameFrame);

  const URL_ATTRS = new Set(['src', 'href', 'action', 'formaction', 'poster', 'background', 'xlink:href']);
  const fixAttribute = (element, name, value) => {
    if (URL_ATTRS.has(name) || (name === 'data' && element.localName === 'object')) return proxify(value);
    if (name === 'srcset' || name === 'imagesrcset') return proxifySrcset(value);
    if (name === 'target') return sameFrame(value);
    return value;
  };

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name, value) {
    return nativeSetAttribute.call(this, name, fixAttribute(this, String(name).toLowerCase(), value));
  };

  // Elements added with innerHTML and the like don't pass through the setters above.
  const SELECTOR = '[src],[href],[action],[formaction],[poster],[srcset],[imagesrcset],[background],[target],object[data]';
  const fixElement = (element) => {
    for (const { name, value } of [...element.attributes]) {
      const fixed = fixAttribute(element, name.toLowerCase(), value);
      if (fixed !== value) nativeSetAttribute.call(element, name, fixed);
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches(SELECTOR)) fixElement(node);
        for (const child of node.querySelectorAll(SELECTOR)) fixElement(child);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  /* ---------- Cookies and storage ---------- */

  // A sandboxed page can't use document.cookie. Keep the cookies the server sent
  // with the page, and send new ones to the server so later requests carry them.
  const cookies = new Map();
  for (const part of (script?.dataset.cookies || '').split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq), part.slice(eq + 1));
  }
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (text) => {
      const [pair, ...attributes] = String(text).split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) return;
      const name = pair.slice(0, eq).trim();
      const expired = attributes.some((attribute) => {
        const [key, value = ''] = attribute.split('=');
        const lower = key.trim().toLowerCase();
        if (lower === 'max-age') return Number(value) <= 0;
        if (lower === 'expires') return Date.parse(value) <= Date.now();
        return false;
      });
      if (expired) cookies.delete(name);
      else cookies.set(name, pair.slice(eq + 1).trim());
      nativeBeacon?.(`${prefix}_cookie`, JSON.stringify({ url: realUrl(location.href), cookie: String(text) }));
    },
  });

  const memoryStorage = () => {
    const data = new Map();
    return {
      get length() {
        return data.size;
      },
      key: (index) => [...data.keys()][index] ?? null,
      getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
      setItem: (key, value) => void data.set(String(key), String(value)),
      removeItem: (key) => void data.delete(String(key)),
      clear: () => data.clear(),
    };
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      void window[name];
    } catch {
      try {
        Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
      } catch {
        // the site will see the error
      }
    }
  }

  /* ---------- Talking to the activity ---------- */

  function report(loading, { leaving = false } = {}) {
    if (window.parent === window) return;
    const url = leaving ? null : realUrl(location.href);
    window.parent.postMessage({ type: 'multishare:web', url, title: document.title, loading }, '*');
  }

  report(true);
  document.addEventListener('DOMContentLoaded', () => report(false));
  window.addEventListener('pagehide', () => report(true, { leaving: true }));
  window.addEventListener('popstate', () => report(false));
  window.addEventListener('hashchange', () => report(false));

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'multishare:web-command') return;
    if (event.data.command === 'pause') {
      for (const media of document.querySelectorAll('video, audio')) media.pause();
      for (let i = 0; i < window.frames.length; i += 1) window.frames[i].postMessage(event.data, '*');
    }
  });
})();
