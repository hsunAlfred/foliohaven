import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse, Command } from './api.js';
import { ApiFailure, isAborted } from './api.js';
import type { StudioApi } from './api.js';

export function useResource<T>(api: StudioApi, path: string) {
  const [version, setVersion] = useState(0);
  const key = `${path}:${version}`;
  const [state, setState] = useState<{
    key: string;
    path: string;
    response: ApiResponse<T> | null;
    error: unknown;
  }>({ key: '', path: '', response: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    void api.get<T>(path, { signal: controller.signal }).then(
      (response) => {
        if (!controller.signal.aborted)
          setState({ key, path, response, error: null });
      },
      (error) => {
        if (!controller.signal.aborted && !isAborted(error))
          setState((previous) => ({
            key,
            path,
            response: previous.path === path ? previous.response : null,
            error,
          }));
      },
    );
    return () => controller.abort();
  }, [api, key, path]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return {
    response: state.path === path ? state.response : null,
    error: state.key === key ? state.error : null,
    loading: state.key !== key,
    reload,
  };
}
interface PendingCommandState {
  readonly command: Command;
  readonly success: (response: ApiResponse<unknown>) => void | Promise<void>;
}
export function useCommand(api: StudioApi) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<PendingCommandState | null>(null);
  const inFlight = useRef(false);
  const pendingRef = useRef<PendingCommandState | null>(null);
  const execute = useCallback(
    async <T>(
      command: Command,
      success: (response: ApiResponse<T>) => void | Promise<void>,
      expectedPending: PendingCommandState | null = null,
    ) => {
      if (inFlight.current)
        throw new ApiFailure(409, 'COMMAND_IN_PROGRESS', '目前操作仍在執行。');
      if (pendingRef.current !== expectedPending)
        throw new ApiFailure(
          409,
          'COMMAND_RESULT_UNCONFIRMED',
          '請先確認先前操作的結果，或使用原請求重送。',
        );
      // React state 在下一次 render 才生效；同一個事件回合也必須禁止重入。
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const response = await api.execute<T>(command);
        pendingRef.current = null;
        setPending(null);
        await success(response);
        return response;
      } catch (failure) {
        setError(failure);
        if (
          command.idempotencyKey !== undefined &&
          failure instanceof ApiFailure &&
          (failure.status === 0 ||
            failure.status === 408 ||
            failure.status >= 500 ||
            failure.code === 'REQUEST_IN_PROGRESS' ||
            (failure.code === 'INVALID_API_RESPONSE' &&
              failure.status >= 200 &&
              failure.status < 300))
        ) {
          const preserved =
            expectedPending ??
            ({
              command,
              success: (response) => success(response as ApiResponse<T>),
            } satisfies PendingCommandState);
          pendingRef.current = preserved;
          setPending(preserved);
        }
        throw failure;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [api],
  );
  const run = useCallback(
    <T>(
      command: Command,
      success: (response: ApiResponse<T>) => void | Promise<void>,
    ) => execute(command, success),
    [execute],
  );
  const retry = useCallback(async () => {
    const original = pendingRef.current;
    if (original) await execute(original.command, original.success, original);
  }, [execute]);
  const clear = useCallback((options?: { discardPending?: boolean }) => {
    if (inFlight.current || (pendingRef.current && !options?.discardPending))
      return false;
    pendingRef.current = null;
    setError(null);
    setPending(null);
    return true;
  }, []);
  return {
    busy,
    error,
    pending,
    run,
    retry,
    clear,
  };
}
export function useVersionedForm<T>(
  api: StudioApi,
  path: string,
  initial: ApiResponse<T>,
  onDirty: (dirty: boolean) => void,
) {
  const [base, setBase] = useState(initial);
  const [value, setValue] = useState(initial.data);
  const [conflict, setConflict] = useState<ApiResponse<T> | null>(null);
  const [validation, setValidation] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const command = useCommand(api);
  const change = (next: T) => {
    setValue(next);
    onDirty(JSON.stringify(next) !== JSON.stringify(base.data));
    setNotice('');
  };
  const save = async (parse: (value: unknown) => T, after?: () => void) => {
    setValidation(null);
    let body: T;
    try {
      body = parse(value);
    } catch (error) {
      setValidation(error);
      return;
    }
    try {
      await command.run<T>(
        {
          label: '保存設定',
          method: 'PUT',
          path,
          body,
          ...(base.etag ? { etag: base.etag } : {}),
        },
        (response) => {
          setBase(response);
          setValue(response.data);
          setConflict(null);
          onDirty(false);
          setNotice('設定已保存。更新網站後，讀者就會看到這次變更。');
          after?.();
        },
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 412) {
        try {
          setConflict(await api.get<T>(path));
        } catch (currentError) {
          setValidation(currentError);
        }
      }
    }
  };
  const adopt = () => {
    if (conflict && window.confirm('以已保存版本取代未保存內容？')) {
      setBase(conflict);
      setValue(conflict.data);
      setConflict(null);
      onDirty(false);
      command.clear();
    }
  };
  return {
    base,
    value,
    change,
    save,
    conflict,
    adopt,
    rebase: () => {
      if (conflict) {
        setBase(conflict);
        setConflict(null);
        onDirty(true);
        command.clear();
      }
    },
    validation,
    notice,
    command,
  };
}
export function usePolling<T>(
  api: StudioApi,
  path: string,
  active: (value: T) => boolean,
  idleIntervalMs = 3000,
  paused = false,
) {
  const [version, setVersion] = useState(0);
  const key = `${path}:${version}`;
  const [state, setState] = useState<{
    key: string;
    path: string;
    response: ApiResponse<T> | null;
    error: unknown;
  }>({ key: '', path: '', response: null, error: null });
  const lastPollingKey = useRef<string | null>(null);
  const hasPollingResponse = useRef(false);
  useEffect(() => {
    const explicitRefresh = lastPollingKey.current !== key;
    lastPollingKey.current = key;
    if (paused && !explicitRefresh && hasPollingResponse.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      let delay = idleIntervalMs;
      try {
        const response = await api.get<T>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        hasPollingResponse.current = true;
        setState({ key, path, response, error: null });
        if (active(response.data) && Date.now() - started < 300000)
          delay = 1000;
      } catch (error) {
        if (controller.signal.aborted || isAborted(error)) return;
        setState((previous) => ({
          key,
          path,
          response: previous.path === path ? previous.response : null,
          error,
        }));
      }
      if (!controller.signal.aborted && !paused)
        timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, api, idleIntervalMs, key, path, paused]);
  return {
    response: state.path === path ? state.response : null,
    error: state.key === key ? state.error : null,
    loading: state.key !== key,
    reload: () => setVersion((value) => value + 1),
  };
}
