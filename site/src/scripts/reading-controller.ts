export {};

/** SSR owns all content and outline links. This controller only adds reading controls. */
const root = document.documentElement;
let anchorNavigation: string | undefined;
let anchorFrame: number | undefined;
function resetSmoothScrolling() {
  if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame);
  anchorFrame = undefined;
  anchorNavigation = undefined;
  delete root.dataset['readingScrollReady'];
}
resetSmoothScrolling();
window.addEventListener('pagehide', resetSmoothScrolling);
window.addEventListener('pageshow', resetSmoothScrolling);
window.addEventListener('popstate', () => {
  if (anchorNavigation === location.href) {
    anchorNavigation = undefined;
    return;
  }
  resetSmoothScrolling();
});
document.addEventListener('click', (event) => {
  if (
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
  const destination = new URL(link.href, location.href);
  if (
    !destination.hash ||
    destination.origin !== location.origin ||
    destination.pathname !== location.pathname ||
    destination.search !== location.search
  )
    return;
  root.dataset['readingScrollReady'] = 'true';
  anchorNavigation = destination.href;
  if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame);
  anchorFrame = requestAnimationFrame(() => {
    anchorFrame = undefined;
    anchorNavigation = undefined;
  });
});

const outlines = [
  ...document.querySelectorAll<HTMLDetailsElement>('[data-reading-toc]'),
];
for (const outline of outlines) {
  const list = outline.querySelector<HTMLElement>('[data-reading-toc-list]');
  const links = [
    ...outline.querySelectorAll<HTMLAnchorElement>('[data-reading-toc-link]'),
  ];
  const targets = new Map<HTMLAnchorElement, HTMLElement>();
  for (const link of links) {
    try {
      const target = document.getElementById(
        decodeURIComponent(link.hash.slice(1)),
      );
      if (target) targets.set(link, target);
    } catch {
      /* A malformed author fragment cannot break other reading controls. */
    }
  }
  let queued = false;
  let userOpening = false;
  const summary = outline.querySelector('summary');
  function updateSection() {
    queued = false;
    if (
      root.hasAttribute('data-modal-open') ||
      document.body.style.position === 'fixed'
    )
      return;
    const padding =
      Number.parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
    const maximum = Math.max(0, root.scrollHeight - innerHeight);
    let active = targets.keys().next().value;
    let closest = -Infinity;
    if (maximum > 1) {
      for (const [link, target] of targets) {
        const margin =
          Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        const landing = Math.max(
          0,
          Math.min(
            maximum,
            scrollY + target.getBoundingClientRect().top - padding - margin,
          ),
        );
        if (landing <= scrollY + 1 && landing >= closest) {
          active = link;
          closest = landing;
        }
      }
    }
    for (const link of links) {
      if (link === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  function queueSectionUpdate() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(updateSection);
  }
  summary?.addEventListener('click', () => {
    userOpening = !outline.open;
  });
  outline.addEventListener('toggle', () => {
    summary?.setAttribute('aria-expanded', String(outline.open));
    if (!userOpening || !outline.open || !list || list.clientHeight === 0) {
      userOpening = false;
      return;
    }
    userOpening = false;
    updateSection();
    const current = list.querySelector<HTMLElement>(
      '[aria-current="location"]',
    );
    if (!current) return;
    const viewport = list.getBoundingClientRect();
    const entry = current.getBoundingClientRect();
    const centered =
      list.scrollTop +
      entry.top -
      viewport.top -
      list.clientTop +
      (entry.height - list.clientHeight) / 2;
    list.scrollTo({
      top: Math.max(
        0,
        Math.min(list.scrollHeight - list.clientHeight, centered),
      ),
      behavior: 'instant',
    });
  });
  window.addEventListener('scroll', queueSectionUpdate, { passive: true });
  window.addEventListener('resize', queueSectionUpdate, { passive: true });
  window.addEventListener('hashchange', queueSectionUpdate);
  window.addEventListener('pageshow', queueSectionUpdate);
  updateSection();
}
