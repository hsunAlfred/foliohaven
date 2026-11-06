import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.js';

export function Dialog({
  open,
  id,
  title,
  onClose,
  children,
  actions,
  className = '',
  closeDisabled = false,
}: {
  open: boolean;
  id?: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      id={id}
      className={`studio-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('dialog') !== event.currentTarget
        )
          return;
        // Search inputs otherwise consume the first Escape to clear their text.
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabled) onClose();
      }}
      onCancel={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || closeDisabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header className="studio-dialog__header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label={`關閉${title}`}
          disabled={closeDisabled}
          onClick={onClose}
        >
          <Icon name="close" />
          關閉
        </button>
      </header>
      <div className="studio-dialog__body">{children}</div>
      {actions && <footer className="studio-dialog__footer">{actions}</footer>}
    </dialog>
  );
}
