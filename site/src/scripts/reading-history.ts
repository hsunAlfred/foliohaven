/** Standalone classic script: compiled into the head before body parsing. */
(() => {
  const ios =
    /iP(?:hone|ad|od)/u.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios || !('scrollRestoration' in history)) return;
  const storageKey = 'foliohaven-reading-history';
  const stateKey = '__foliohavenReading';
  const root = document.documentElement;
  type Position = { url: string; x: number; y: number };
  type Restoration = {
    key: string;
    point: Position;
    deadline?: number;
    frame?: number;
    timeout?: number;
    observer: MutationObserver;
  };
  let enabled = true;
  let entryKey = '';
  let entryUrl = location.href;
  let readingPosition: Position | undefined;
  let saveTimer: number | undefined;
  let suspended = false;
  let pageShown = false;
  let restorationGeneration = 0;
  let readerInteracted = false;
  let hadSnapshotAtStart: boolean;
  let awaitingEntry = false;
  let pending: Restoration | undefined;
  const freshKeys = new Set<string>();
  function positions(): Record<string, Position> {
    const stored: unknown = JSON.parse(
      sessionStorage.getItem(storageKey) ?? '{}',
    );
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, Position>)
      : {};
  }
  function clearSaveTimer() {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  function clearRestoration() {
    if (!pending) return;
    if (pending.frame !== undefined) cancelAnimationFrame(pending.frame);
    if (pending.timeout !== undefined) window.clearTimeout(pending.timeout);
    pending.observer.disconnect();
    pending = undefined;
  }
  function fallback() {
    enabled = false;
    clearSaveTimer();
    clearRestoration();
    history.scrollRestoration = 'auto';
  }
  function newKey() {
    // LAN previews may not provide randomUUID; this is not a secret.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  function historyState() {
    const state: unknown = history.state;
    if (state === null) return {};
    if (
      typeof state === 'object' &&
      state !== null &&
      Object.getPrototypeOf(state) === Object.prototype
    )
      return state as Record<string, unknown>;
    throw new Error('Unsupported history state');
  }
  function adoptEntry() {
    const state = historyState();
    const key = state[stateKey];
    if (typeof key === 'string' && /^[a-z0-9-]{1,80}$/u.test(key))
      entryKey = key;
    else {
      entryKey = newKey();
      freshKeys.add(entryKey);
      history.replaceState({ ...state, [stateKey]: entryKey }, '');
    }
    entryUrl = location.href;
    awaitingEntry = false;
    // iOS can lose plain-URL positions too. Set this before parsing the body.
    history.scrollRestoration = 'manual';
  }
  function backgroundLocked() {
    return (
      root.hasAttribute('data-modal-open') ||
      ['directory', 'tag', 'search'].some((name) =>
        root.classList.contains(`site-${name}-modal-open`),
      )
    );
  }
  function capturePosition() {
    if (!enabled || suspended || pending || awaitingEntry || !document.body)
      return;
    if (backgroundLocked() && document.body.style.position === 'fixed') {
      const top = -Number.parseFloat(document.body.style.top);
      if (Number.isFinite(top))
        readingPosition = {
          url: entryUrl,
          x: readingPosition?.x ?? 0,
          y: top,
        };
    } else readingPosition = { url: entryUrl, x: scrollX, y: scrollY };
  }
  function savePosition() {
    clearSaveTimer();
    if (
      !enabled ||
      suspended ||
      pending ||
      awaitingEntry ||
      !readingPosition ||
      readingPosition.url !== entryUrl
    )
      return;
    try {
      const stored = new Map(Object.entries(positions()));
      stored.delete(entryKey);
      stored.set(entryKey, readingPosition);
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(Object.fromEntries([...stored].slice(-64))),
      );
      freshKeys.delete(entryKey);
      // pagehide can expose the destination entry already. Flush only the
      // source document's cached point; never mutate history state/mode here.
    } catch {
      fallback();
    }
  }
  function contentReady() {
    if (
      document.readyState === 'loading' ||
      !document.body ||
      backgroundLocked()
    )
      return false;
    if (location.pathname !== '/articles/' || !location.search) return true;
    const search = document.querySelector<HTMLElement>('[data-search-state]');
    return Boolean(
      search &&
      search.dataset['searchState'] !== 'loading' &&
      search.dataset['searchResultState'] !== 'pending' &&
      search.dataset['searchFeedback'] !== 'searching' &&
      !root.hasAttribute('data-search-boot'),
    );
  }
  function applyRestoration() {
    const restoration = pending;
    if (!restoration) return;
    if (!contentReady()) {
      if (pageShown && restoration.timeout === undefined)
        restoration.timeout = window.setTimeout(() => {
          if (pending !== restoration) return;
          clearRestoration();
          capturePosition();
        }, 30000);
      return;
    }
    delete root.dataset['readingScrollReady'];
    const target = {
      url: entryUrl,
      x: Math.max(
        0,
        Math.min(restoration.point.x, root.scrollWidth - innerWidth),
      ),
      y: Math.max(
        0,
        Math.min(restoration.point.y, root.scrollHeight - innerHeight),
      ),
    };
    if (Math.abs(scrollX - target.x) > 1 || Math.abs(scrollY - target.y) > 1)
      window.scrollTo({ left: target.x, top: target.y, behavior: 'instant' });
    readingPosition = target;
    if (pageShown && restoration.deadline === undefined)
      restoration.deadline = performance.now() + 1000;
    if (
      restoration.deadline !== undefined &&
      performance.now() >= restoration.deadline
    ) {
      clearRestoration();
      savePosition();
      return;
    }
    if (restoration.frame === undefined)
      restoration.frame = requestAnimationFrame(() => {
        delete restoration.frame;
        applyRestoration();
      });
  }
  function restorePosition() {
    if (!enabled) return;
    try {
      const point = positions()[entryKey];
      if (point && point.url !== location.href) {
        // A BFCache pageshow may precede popstate's final active-entry state.
        awaitingEntry = true;
        clearSaveTimer();
        return;
      }
      if (
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0
      ) {
        if (!freshKeys.has(entryKey)) history.scrollRestoration = 'auto';
        return;
      }
      if (pending?.key === entryKey) {
        applyRestoration();
        return;
      }
      clearRestoration();
      clearSaveTimer();
      const observer = new MutationObserver(applyRestoration);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'data-search-state',
          'data-search-result-state',
          'data-search-feedback',
          'data-search-boot',
          'class',
          'style',
        ],
      });
      pending = {
        key: entryKey,
        point,
        observer,
      };
      applyRestoration();
    } catch {
      fallback();
    }
  }
  function userIntent() {
    if (!enabled) return;
    restorationGeneration++;
    readerInteracted = true;
    // Any new gesture belongs to the reader, including during restoration.
    clearRestoration();
    awaitingEntry = false;
    capturePosition();
  }
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(positions()));
    adoptEntry();
    const point = positions()[entryKey];
    hadSnapshotAtStart = Boolean(
      point &&
      point.url === location.href &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.y >= 0,
    );
  } catch {
    fallback();
    return;
  }
  const navigation = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const restoreInitialEntry =
    navigation?.type === 'back_forward' ||
    navigation?.type === 'reload' ||
    hadSnapshotAtStart;
  if (restoreInitialEntry) restorePosition();
  document.addEventListener('DOMContentLoaded', () => {
    if (pending) applyRestoration();
    else capturePosition();
  });
  window.addEventListener('load', applyRestoration);
  window.addEventListener(
    'scroll',
    () => {
      if (suspended || !enabled) return;
      if (pending) {
        applyRestoration();
        return;
      }
      capturePosition();
      if (saveTimer === undefined && !awaitingEntry)
        saveTimer = window.setTimeout(savePosition, 150);
    },
    { passive: true },
  );
  for (const event of [
    'pointerdown',
    'touchstart',
    'wheel',
    'keydown',
  ] as const)
    document.addEventListener(event, userIntent, {
      capture: true,
      passive: true,
    });
  window.addEventListener('pagehide', () => {
    // A transition can reset live scrollY already; keep the last cached point.
    savePosition();
    suspended = true;
    pageShown = false;
    restorationGeneration++;
    readerInteracted = false;
    clearSaveTimer();
    clearRestoration();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition();
  });
  window.addEventListener('pageshow', (event) => {
    suspended = false;
    pageShown = true;
    const generation = ++restorationGeneration;
    try {
      adoptEntry();
      if (!readerInteracted && (event.persisted || restoreInitialEntry)) {
        restorePosition();
        window.setTimeout(() => {
          if (
            !enabled ||
            suspended ||
            readerInteracted ||
            generation !== restorationGeneration
          )
            return;
          try {
            adoptEntry();
            restorePosition();
          } catch {
            fallback();
          }
        }, 0);
      } else capturePosition();
    } catch {
      fallback();
    }
  });
  window.addEventListener('popstate', (event) => {
    if (!enabled) return;
    restorationGeneration++;
    try {
      if (historyState()[stateKey] !== entryKey || location.href !== entryUrl) {
        savePosition();
        readerInteracted = false;
      }
      clearRestoration();
      adoptEntry();
      if (event.isTrusted && !readerInteracted) restorePosition();
      else capturePosition(); // Search emits this after pushState(null, ...).
    } catch {
      fallback();
    }
  });
  document.addEventListener('click', (event) => {
    if (
      !enabled ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    if (
      !link ||
      link.hasAttribute('download') ||
      (link.target && link.target !== '_self')
    )
      return;
    userIntent();
    savePosition();
    if (!enabled) return;
    const destination = new URL(link.href, location.href);
    if (
      !destination.hash ||
      destination.origin !== location.origin ||
      destination.pathname !== location.pathname ||
      destination.search !== location.search
    )
      return;
    let target: HTMLElement | null;
    try {
      target = document.getElementById(
        decodeURIComponent(destination.hash.slice(1)),
      );
    } catch {
      return;
    }
    if (!target) return;
    try {
      if (destination.href !== location.href) {
        const nextKey = newKey();
        history.pushState(
          { ...historyState(), [stateKey]: nextKey },
          '',
          destination,
        );
        entryKey = nextKey;
        entryUrl = destination.href;
        freshKeys.add(nextKey);
        history.scrollRestoration = 'manual';
      }
    } catch {
      fallback();
      return;
    }
    event.preventDefault();
    const hadTabIndex = target.hasAttribute('tabindex');
    if (!hadTabIndex) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    if (!hadTabIndex) target.removeAttribute('tabindex');
    target.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start',
    });
  });
})();
