import type { ReactNode } from 'react';

export interface StateMessageProps {
  readonly kind?: 'empty' | 'loading' | 'error' | 'info';
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}
export function StateMessage({
  kind = 'empty',
  title,
  children,
  action,
}: StateMessageProps) {
  return (
    <div
      className={`state-message state-${kind}`}
      {...(kind === 'error'
        ? { role: 'alert' }
        : kind === 'loading'
          ? { role: 'status', 'aria-live': 'polite' as const }
          : {})}
    >
      <p className="state-title">{title}</p>
      {children !== undefined && (
        <div className="state-description">{children}</div>
      )}
      {action !== undefined && <div className="state-action">{action}</div>}
    </div>
  );
}
