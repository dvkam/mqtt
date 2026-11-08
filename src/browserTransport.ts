import { openMqttWebSocket } from './websocket.js';

export type BrowserCloseKind = 'remote' | 'local' | 'abort' | 'error';

export interface BrowserTransport {
  /** Admission to the native send queue. Completion does not imply broker receipt. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  send(bytes: Uint8Array<ArrayBuffer>): void;
  /** Retire immediately. Reject on a close deadline or a throwing onClose observer. */
  close(): Promise<void>;
}

interface BrowserTransportOptions {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  onBytes: (bytes: Uint8Array<ArrayBuffer>) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  onClose: (reason: Error, kind: BrowserCloseKind) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBufferedBytes?: number;
  maxWebSocketMessageBytes?: number;
}

export async function openBrowserTransport(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  url: string | URL,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  options: BrowserTransportOptions,
): Promise<BrowserTransport> {
  const {
    onBytes,
    onClose,
    signal,
    timeoutMs = 3000,
    maxBufferedBytes = 1024 * 1024,
    maxWebSocketMessageBytes = 1024 * 1024,
  } = options;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new RangeError('WebSocket write budget must be a positive safe integer');
  }
  if (!Number.isInteger(maxWebSocketMessageBytes) || maxWebSocketMessageBytes < 1 || maxWebSocketMessageBytes > 2_147_483_647) {
    throw new RangeError('WebSocket receive message limit must be an integer from 1 to 2147483647');
  }
  const socket = await openMqttWebSocket(url, { signal, timeoutMs });
  let failure: Error | undefined;
  let observerError: Error | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let settle!: (closed: boolean) => void;
  const closed = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const finish = (complete: boolean) => {
    clearTimeout(deadline);
    socket.removeEventListener('close', nativeClosed);
    settle(complete);
  };
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  const retire = (reason: Error, kind: BrowserCloseKind) => {
    if (failure) return;
    failure = reason;
    socket.removeEventListener('message', message);
    socket.removeEventListener('error', errored);
    signal?.removeEventListener('abort', aborted);
    deadline = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    try {
      onClose(reason, kind);
    } catch (error) {
      observerError = error instanceof Error ? error : new Error('MQTT WebSocket close observer failed');
    }
  };
  const nativeClosed = () => {
    retire(new Error('MQTT WebSocket closed'), 'remote');
    finish(true);
  };
  const errored = () => {
    retire(new Error('MQTT WebSocket failed'), 'error');
  };
  const aborted = () => {
    const reason: unknown = signal?.reason;
    retire(reason instanceof Error ? reason : new Error('MQTT WebSocket aborted'), 'abort');
  };
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
  const message = (event: MessageEvent) => {
    if (failure) return;
    if (!(event.data instanceof ArrayBuffer)) {
      retire(new Error('MQTT WebSocket requires binary messages'), 'error');
      return;
    }
    if (event.data.byteLength > maxWebSocketMessageBytes) {
      retire(new RangeError('WebSocket receive message limit exceeded'), 'error');
      return;
    }
    try {
      onBytes(new Uint8Array(event.data));
    } catch (error) {
      retire(error instanceof Error ? error : new Error('MQTT WebSocket byte handler failed'), 'error');
    }
  };
  socket.addEventListener('message', message);
  socket.addEventListener('error', errored);
  socket.addEventListener('close', nativeClosed);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted === true) {
    aborted();
    throw failure ?? new Error('MQTT WebSocket aborted');
  }
  return {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This transport boundary uses native sockets, signals and mutable byte views.
    send(bytes) {
      if (failure) throw failure;
      if (socket.readyState !== WebSocket.OPEN) throw new Error('MQTT WebSocket closed');
      if (bytes.byteLength > maxBufferedBytes - socket.bufferedAmount) throw new Error('WebSocket write budget exceeded');
      socket.send(bytes);
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    close() {
      closing ??= closed.then((complete) => {
        if (observerError) throw observerError;
        if (!complete) throw new Error('MQTT WebSocket close timed out');
      });
      retire(new Error('MQTT WebSocket closed locally'), 'local');
      return closing;
    },
  };
}
