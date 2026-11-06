import type { Socket } from 'node:net';

export interface BrowserProxySummary {
  readonly schemaVersion: 1;
  readonly connectRequests: number;
  readonly pinnedConnections: number;
  readonly rejectedConnections: number;
  readonly rejectedRequests: number;
  readonly dnsFailures: number;
  readonly socketFailures: number;
  readonly timeouts: number;
  readonly bytesFromBrowser: number;
  readonly bytesFromOrigin: number;
  readonly firstFailureCode: string | null;
  readonly healthy: boolean;
  readonly closed: boolean;
  readonly activeClientConnections: number;
  readonly activeTunnels: number;
}
export interface BrowserProxyOptions {
  readonly domain: string;
  readonly signal?: AbortSignal;
  readonly lookup?: (
    hostname: string,
    options: { readonly all: true; readonly verbatim: true },
  ) => Promise<
    readonly { readonly address: string; readonly family: number }[]
  >;
  /** Isolated tests only; production always connects to the validated literal IP. */
  readonly connect?: (options: {
    readonly host: string;
    readonly family: number;
    readonly port: 443;
  }) => Socket;
}
export interface BrowserProxy {
  readonly server: string;
  close(): Promise<void>;
  assertHealthy(): void;
  summary(): BrowserProxySummary;
}
/** CONNECT only. Caller still owns browser method/path guards and public SHA checks. */
export function createBrowserProxy(
  options: BrowserProxyOptions,
): Promise<BrowserProxy>;
