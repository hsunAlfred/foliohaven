import type { JobRetryInput } from '@foliohaven/core';
export type TaxonomyRetry = Extract<JobRetryInput, { type: 'taxonomy' }> & {
  readonly retryOf: string;
};
