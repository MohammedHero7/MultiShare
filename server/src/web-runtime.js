// Runs in the browser, not on the server: web.js adds it to the top of every website
// opened in the activity's browser, so it runs before the site's own scripts.
//
// The server already pointed the page's links at /api/web. This does the same for
// whatever the site's scripts load or open later, stands in for cookies and storage
// (a sandboxed page has neither), carries messages between frames, and tells the
// activity which address is open.
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
  // Before the site's scripts get a wrapped one (see "Messages between frames").
  const nativeParent = window.parent;

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

  // reCAPTCHA tells Google which site it's on with "co" in its frame addresses: the
  // page's origin and port in base64. It works that out from location, which here is
  // this server, so Google would answer "Invalid domain for site key".
  const RECAPTCHA_HOST = /^(www\.)?(google\.com|recaptcha\.net)$/i;
  const recaptchaOrigin = (() => {
    const { protocol, hostname, port } = new URL(pageOrigin);
    const origin = `${protocol}//${hostname}:${port || (protocol === 'https:' ? '443' : '80')}`;
    return btoa(origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '.');
  })();

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
    if (RECAPTCHA_HOST.test(url.hostname) && url.pathname.startsWith('/recaptcha/')) {
      url.search = url.search.replace(/([?&]co=)[^&]*/, `$1${recaptchaOrigin}`);
    }
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

  /* ---------- Workers ---------- */

  // A sandboxed page can only start a worker from a blob: or data: address. For any
  // other, the worker starts from a small blob that points the worker's own requests
  // at this server too, then loads the real script through it.
  function setUpWorker(proxyOrigin, webPrefix, scriptUrl) {
    const fix = (value) => {
      let url;
      try {
        url = new URL(String(value), scriptUrl);
      } catch {
        return value;
      }
      if (url.origin === proxyOrigin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return value;
      return `${proxyOrigin}${webPrefix}${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}`;
    };
    const nativeImport = self.importScripts;
    self.importScripts = (...urls) => nativeImport(...urls.map(fix));
    const nativeWorkerFetch = self.fetch;
    self.fetch = (input, init) => nativeWorkerFetch(input instanceof Request ? input : fix(input), init);
    if (self.XMLHttpRequest) {
      const nativeOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
        return nativeOpen.call(this, method, fix(url), ...rest);
      };
    }
  }

  const NativeWorker = window.Worker;
  if (NativeWorker) {
    const workerSource = (url, options) => {
      if (/^\s*(blob|data):/i.test(String(url))) return url;
      const address = new URL(proxify(url), document.baseURI).href;
      const real = realUrl(address);
      if (!real) return url;
      const setup = `(${setUpWorker})(${JSON.stringify(location.origin)}, ${JSON.stringify(prefix)}, ${JSON.stringify(real)});`;
      const load = options?.type === 'module' ? `import(${JSON.stringify(address)});` : `importScripts(${JSON.stringify(address)});`;
      return URL.createObjectURL(new Blob([setup + load], { type: 'text/javascript' }));
    };
    window.Worker = class Worker extends NativeWorker {
      constructor(url, options) {
        super(workerSource(url, options), options);
      }
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

  /* ---------- Messages between frames ---------- */

  // Every page here runs in an opaque origin of its own, and so does every frame in it,
  // even about:blank. The browser only delivers a message to another frame when
  // targetOrigin is "*", and says it came from "null", while sites check both
  // (reCAPTCHA, video players, sign-in widgets). So a message goes out as "*" in an
  // envelope naming the website origins at both ends, and the runtime in the receiving
  // page checks the target and unwraps it.
  const ENVELOPE = '__multishareMessage';
  const isEnvelope = (data) => data !== null && typeof data === 'object' && data[ENVELOPE] === 1;
  // A page here also sees this server as its own origin (location.origin).
  const accepts = (origin) => origin === '*' || origin === pageOrigin || origin === location.origin;

  /** postMessage(message, targetOrigin, transfer) or postMessage(message, { targetOrigin, transfer }). */
  function readPost([message, second, third]) {
    const options = second == null || typeof second === 'object' ? (second ?? {}) : null;
    const target = String(options ? (options.targetOrigin ?? '/') : second);
    const transfer = (options ? options.transfer : third) ?? [];
    if (target === '*') return { message, to: '*', transfer };
    if (target === '/') return { message, to: pageOrigin, transfer };
    try {
      return { message, to: new URL(target).origin, transfer };
    } catch {
      throw new DOMException(`Invalid target origin '${target}' in a call to 'postMessage'.`, 'SyntaxError');
    }
  }

  const nativeSelfPost = window.postMessage;

  function send(target, args) {
    const { message, to, transfer } = readPost(args);
    const envelope = { [ENVELOPE]: 1, data: message, from: pageOrigin, to };
    if (target === window) nativeSelfPost.call(window, envelope, '*', transfer);
    else target.postMessage(envelope, '*', transfer);
  }

  // The site's scripts get windows through these wrappers, so postMessage on them
  // goes through send(). Each window keeps one wrapper, so comparisons still work.
  const wrappers = new WeakMap();
  const wrapped = new WeakMap();
  const posters = new WeakMap();
  const callers = new WeakMap();

  const isWindow = (value) => {
    if (value === null || typeof value !== 'object') return false;
    try {
      return value.window === value;
    } catch {
      return false;
    }
  };

  // Functions read through a wrapper still run on the real window.
  const callable = (fn) => {
    let caller = callers.get(fn);
    if (!caller) {
      caller = new Proxy(fn, { apply: (target, self, args) => Reflect.apply(target, wrapped.get(self) ?? self, args) });
      callers.set(fn, caller);
    }
    return caller;
  };

  const windowHandler = {
    get(target, key) {
      if (key === 'postMessage') {
        let post = posters.get(target);
        if (!post) {
          post = function postMessage(...args) {
            return send(target, args);
          };
          posters.set(target, post);
        }
        return post;
      }
      const value = Reflect.get(target, key, target);
      if (isWindow(value)) return wrapWindow(value);
      return typeof value === 'function' ? callable(value) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, key === 'location' ? proxify(value) : value, target);
    },
  };

  function wrapWindow(win) {
    if (win === window || wrapped.has(win) || !isWindow(win)) return win;
    let wrapper = wrappers.get(win);
    if (!wrapper) {
      wrapper = new Proxy(win, windowHandler);
      wrappers.set(win, wrapper);
      wrapped.set(wrapper, win);
    }
    return wrapper;
  }

  const patchGetter = (proto, name, map) => {
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor?.get) return;
    Object.defineProperty(proto, name, {
      ...descriptor,
      get() {
        return map.call(this, descriptor.get.call(this));
      },
    });
  };

  const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent');
  if (parentDescriptor?.configurable) {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      enumerable: parentDescriptor.enumerable,
      get: () => wrapWindow(nativeParent),
      set: (value) => Object.defineProperty(window, 'parent', { configurable: true, enumerable: true, writable: true, value }),
    });
  }
  for (const type of [window.HTMLIFrameElement, window.HTMLFrameElement, window.HTMLObjectElement]) {
    patchGetter(type?.prototype, 'contentWindow', wrapWindow);
  }

  window.postMessage = function postMessage(...args) {
    const target = wrapped.get(this) ?? this;
    return send(isWindow(target) ? target : window, args);
  };

  // Receiving: drop envelopes meant for another website, and unwrap the rest. This
  // listener comes before any of the site's own.
  const eventData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  const eventSource = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source').get;
  window.addEventListener(
    'message',
    (event) => {
      const data = eventData.call(event);
      if (isEnvelope(data) && !accepts(data.to)) event.stopImmediatePropagation();
    },
    true,
  );
  patchGetter(MessageEvent.prototype, 'data', (data) => (isEnvelope(data) ? data.data : data));
  patchGetter(MessageEvent.prototype, 'origin', function (origin) {
    const data = eventData.call(this);
    return isEnvelope(data) ? data.from : origin;
  });
  patchGetter(MessageEvent.prototype, 'source', wrapWindow);

  /* ---------- Talking to the activity ---------- */

  function report(loading, { leaving = false } = {}) {
    if (nativeParent === window) return;
    const url = leaving ? null : realUrl(location.href);
    nativeParent.postMessage({ type: 'multishare:web', url, title: document.title, loading }, '*');
  }

  report(true);
  document.addEventListener('DOMContentLoaded', () => report(false));
  window.addEventListener('pagehide', () => report(true, { leaving: true }));
  window.addEventListener('popstate', () => report(false));
  window.addEventListener('hashchange', () => report(false));

  window.addEventListener('message', (event) => {
    const data = eventData.call(event);
    if (eventSource.call(event) !== nativeParent || data?.type !== 'multishare:web-command') return;
    if (data.command === 'pause') {
      for (const media of document.querySelectorAll('video, audio')) media.pause();
      for (let i = 0; i < window.frames.length; i += 1) window.frames[i].postMessage(data, '*');
    }
  });
})();
