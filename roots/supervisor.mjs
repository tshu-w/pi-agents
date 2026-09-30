function fault(code, message, uncertainDelivery = false) {
  return Object.assign(new Error(message), { code, uncertainDelivery });
}

// Bound the wait even when an injected operation ignores its signal. Aborting
// this signal stops observation/retries, not work already accepted by a Worker.
function bounded(run, { signal, timeoutMs }, interruption) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, timer;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    function interrupt(code) {
      const error = interruption(code);
      finish(error);
      controller.abort(error);
    }
    const abort = () => interrupt('ABORT_ERR');
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => interrupt('ETIMEDOUT'), timeoutMs);
    try {
      Promise.resolve(run({ signal: controller.signal, timeoutMs })).then(
        value => finish(null, value), error => finish(error),
      );
    } catch (error) { finish(error); }
  });
}

function validateAck(value, message) {
  if (value?.accepted !== true || value.messageId !== message.id) {
    throw fault('INVALID_ACK', `Invalid acknowledgement for Message ${message.id}; the recipient may have received it`, true);
  }
  return value;
}

export function createSupervisor({ deliverToWorker, wake }) {
  const waking = new Map();
  function wakeOnce(recipient, { signal, timeoutMs }) {
    signal.throwIfAborted();
    let shared = waking.get(recipient);
    if (!shared) {
      shared = { controller: new AbortController(), waiters: 0, settled: false };
      // Register waiters before invoking wake, which may itself cancel a caller.
      // The first caller supplies the deadline; all waiters own the lifetime.
      shared.pending = bounded(options => Promise.resolve().then(() => {
        options.signal.throwIfAborted();
        return wake(recipient, options);
      }), { signal: shared.controller.signal, timeoutMs },
      code => fault(code, `Wake ${code === 'ABORT_ERR' ? 'cancelled' : 'timed out'} for Agent ${recipient}`))
        .finally(() => {
          shared.settled = true;
          if (waking.get(recipient) === shared) waking.delete(recipient);
        });
      waking.set(recipient, shared);
    }
    shared.waiters++;
    return new Promise((resolve, reject) => {
      let finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort);
        shared.waiters--;
        if (!shared.waiters && !shared.settled) {
          if (waking.get(recipient) === shared) waking.delete(recipient);
          shared.controller.abort();
        }
        if (error) reject(error); else resolve();
      }
      const abort = () => finish(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      shared.pending.then(() => finish(), error => finish(error));
    });
  }
  return {
    async accept(message, { signal, timeoutMs = 10000 } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
        throw fault('INVALID_TIMEOUT', 'timeoutMs must be positive and at most 2147483647');
      }
      let delivering = false;
      return bounded(async options => {
        delivering = true;
        try {
          return validateAck(await deliverToWorker(message, options), message);
        } catch (error) {
          options.signal.throwIfAborted();
          if (error?.uncertainDelivery || !['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
        }
        delivering = false;
        await wakeOnce(message.recipient, options);
        options.signal.throwIfAborted();
        delivering = true;
        return validateAck(await deliverToWorker(message, options), message);
      }, { signal, timeoutMs }, code => fault(code,
        `${code === 'ABORT_ERR' ? 'Send cancelled' : 'Send timed out'}${delivering ? '; the recipient may have received it' : ''}`, delivering));
    },
  };
}
