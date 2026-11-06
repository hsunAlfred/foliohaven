import type { LocalRuntimeOptions } from '../runtime/services.js';

export interface LocalServiceOptions extends LocalRuntimeOptions {
  /** 記憶體內由Node協調器傳入；不經瀏覽器、檔案或VITE_變數。 */
  readonly proxyToken: string;
}
export interface LocalService {
  listen(options?: { readonly port?: number }): Promise<{
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly url: string;
  }>;
  close(): Promise<void>;
}
