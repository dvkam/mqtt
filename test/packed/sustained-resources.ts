type ListenerEntry = Readonly<{ target: object; type: unknown; callback: unknown; capture: boolean }>;

export function observeBrowserResources(signal: unknown) {
  const addDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener');
  const removeDescriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'removeEventListener');
  if (!addDescriptor || !removeDescriptor) throw new Error('Expected EventTarget property descriptors');
  const originalAdd: unknown = addDescriptor.value;
  const originalRemove: unknown = removeDescriptor.value;
  if (typeof originalAdd !== 'function' || typeof originalRemove !== 'function')
    throw new Error('Expected native EventTarget methods');
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const originalTask = window.setTimeout.bind(window);
  const sockets = new Set<WebSocket>();
  const listeners: ListenerEntry[] = [];
  const timers = new Set<unknown>();
  let expired = 0;

  function observeListener(target: unknown, parameters: readonly unknown[], adding: boolean) {
    if (!(target instanceof WebSocket) && target !== signal) return;
    if (typeof target !== 'object' || target === null) return;
    if (target instanceof WebSocket) sockets.add(target);
    const [type, callback, options] = parameters;
    if (callback === undefined || callback === null) return;
    const capture =
      typeof options === 'boolean'
        ? options
        : typeof options === 'object' && options !== null && 'capture' in options && options.capture === true;
    const index = listeners.findIndex(
      (entry) => entry.target === target && entry.type === type && entry.callback === callback && entry.capture === capture,
    );
    if (adding && index === -1) listeners.push({ target, type, callback, capture });
    if (!adding && index !== -1) listeners.splice(index, 1);
  }

  Object.defineProperty(EventTarget.prototype, 'addEventListener', {
    ...addDescriptor,
    value: new Proxy(originalAdd, {
      apply(_add: unknown, target: unknown, parameters: readonly unknown[]) {
        const result: unknown = Reflect.apply(originalAdd, target, parameters);
        observeListener(target, parameters, true);
        return result;
      },
    }),
  });
  Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
    ...removeDescriptor,
    value: new Proxy(originalRemove, {
      apply(_remove: unknown, target: unknown, parameters: readonly unknown[]) {
        const result: unknown = Reflect.apply(originalRemove, target, parameters);
        observeListener(target, parameters, false);
        return result;
      },
    }),
  });
  globalThis.setTimeout = new Proxy<typeof originalTimeout>(originalTimeout, {
    apply(_schedule: unknown, target: unknown, parameters: readonly unknown[]) {
      const [callback, ...rest] = parameters;
      if (typeof callback !== 'function') {
        const result: unknown = Reflect.apply(originalTimeout, target, parameters);
        return result;
      }
      const wrapped = function (this: unknown, ...args: readonly unknown[]) {
        timers.delete(handle);
        expired++;
        Reflect.apply(callback, this, args);
      };
      const handle: unknown = Reflect.apply(originalTimeout, target, [wrapped, ...rest]);
      timers.add(handle);
      return handle;
    },
  });
  globalThis.clearTimeout = new Proxy(originalClear, {
    apply(clear, target: unknown, parameters: readonly unknown[]) {
      const result: unknown = Reflect.apply(clear, target, parameters);
      timers.delete(parameters[0]);
      return result;
    },
  });

  return {
    snapshot() {
      return {
        sockets: sockets.size,
        socketListeners: listeners.filter(({ target }) => target !== signal).length,
        signalListeners: listeners.filter(({ target }) => target === signal).length,
        timers: timers.size,
        expired,
      };
    },
    async nativeClosed() {
      await Promise.all(
        [...sockets].map(async (socket: Readonly<Pick<WebSocket, 'readyState'>>) => {
          if (socket.readyState === WebSocket.CLOSED) return;
          await new Promise<void>((resolve) => {
            Reflect.apply(originalAdd, socket, [
              'close',
              () => {
                resolve();
              },
              { once: true },
            ]);
          });
        }),
      );
    },
    async nextTask() {
      await new Promise<void>((resolve) => {
        originalTask(resolve, 0);
      });
    },
    restore() {
      Object.defineProperty(EventTarget.prototype, 'addEventListener', addDescriptor);
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', removeDescriptor);
      globalThis.setTimeout = originalTimeout;
      globalThis.clearTimeout = originalClear;
    },
  };
}
