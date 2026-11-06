import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';

export function ResourceHeading({
  title,
  icon,
  loading,
  loadingLabel,
}: {
  title: string;
  icon: IconName;
  loading: boolean;
  loadingLabel: string;
}) {
  return (
    <>
      <h2 title={loading ? loadingLabel : undefined}>
        <Icon
          name={loading ? 'refresh' : icon}
          size={24}
          className={loading ? 'resource-heading-loading' : ''}
        />
        {title}
      </h2>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {loading ? loadingLabel : ''}
      </p>
    </>
  );
}
