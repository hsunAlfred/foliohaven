import type { JsonValue, Operation, SafeError } from '@foliohaven/core';
import type { FileRepository, OperationReceipt } from '../files/index.js';

export interface OperationReservation {
  readonly id: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface StoredResponse {
  readonly httpStatus: number;
  readonly response?: JsonValue;
  readonly headers?: { readonly ETag?: string; readonly Location?: string };
  readonly resourceUrl?: string;
  readonly jobUrl?: string;
}
export type ReservationResult =
  | { readonly status: 'reserved'; readonly reservation: OperationReservation }
  | { readonly status: 'replay'; readonly response: StoredResponse };
export interface OperationStoreOptions {
  readonly repositoryRoot: string;
  readonly repository?: FileRepository;
  readonly clock?: () => Date;
  readonly recoverReceipts?: () => Promise<readonly OperationReceipt[]>;
  readonly fault?: (
    phase: 'reserved' | 'committed',
    operationId: string,
  ) => void | Promise<void>;
}
export interface OperationRecord {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly reservation: OperationReservation;
  readonly summary: Operation;
  readonly response: StoredResponse | null;
  readonly error: SafeError | null;
}
