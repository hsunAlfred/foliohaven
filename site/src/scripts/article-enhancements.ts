import { resolveCodeLanguage } from './code-language.js';

/** Enhance the SSR article without changing its text or initial block height. */
for (const body of document.querySelectorAll<HTMLElement>(
  '[data-article-body]',
)) {
  for (const pre of body.querySelectorAll<HTMLPreElement>('pre')) {
    const code = pre.querySelector('code');
    if (!code || pre.parentElement?.classList.contains('code-block')) continue;
    const raw = code.textContent;
    const label = resolveCodeLanguage(raw, {
      codeLanguage:
        code.getAttribute('data-language') ?? code.getAttribute('data-lang'),
      codeClass: code.className,
      preLanguage:
        pre.getAttribute('data-language') ?? pre.getAttribute('data-lang'),
      preClass: pre.className,
    });
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const caption = document.createElement('span');
    caption.textContent = label;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '複製程式碼';
    button.setAttribute('aria-label', `複製 ${label} 程式碼`);
    const status = document.createElement('span');
    status.className = 'code-copy-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(caption, button, status);
    pre.before(wrapper);
    wrapper.append(toolbar, pre);
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', `${label} 程式碼，可捲動閱讀`);
    let reset: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener('click', async () => {
      if (reset !== undefined) clearTimeout(reset);
      let success = false;
      try {
        await navigator.clipboard.writeText(raw);
        success = true;
      } catch {
        const field = document.createElement('textarea');
        field.value = raw;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        field.setAttribute('readonly', '');
        document.body.append(field);
        field.select();
        try {
          success = document.execCommand('copy');
        } catch {
          /* Accessible feedback below. */
        }
        field.remove();
        button.focus({ preventScroll: true });
      }
      button.textContent = success ? '已複製' : '請手動選取複製';
      status.textContent = success
        ? '程式碼已複製'
        : '無法存取剪貼簿，請手動選取程式碼。';
      reset = setTimeout(() => {
        button.textContent = '複製程式碼';
        status.textContent = '';
      }, 2400);
    });
  }
}
