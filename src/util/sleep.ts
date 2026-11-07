export function sleep(time?: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let outerReject: (reason?: unknown) => void;
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve, reject) => {
    outerReject = reject;
    timer = setTimeout(resolve, time);
  });
  const cancel = () => {
    clearTimeout(timer);
    outerReject(new Error('sleep cancelled'));
  };
  return { promise, cancel };
}

/**
 {promise: Promise<void>, cancel: () => void}
 */
