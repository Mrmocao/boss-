/** Local-only CDP transport. No credentials, website endpoints or UI actions live here. */
export class ConnectorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ConnectorError('INVALID_TIMEOUT', 'timeoutMs must be an integer from 1 to 120000.');
  }
}

export function validateEndpoint(endpoint) {
  // Validate the spelling as well as the URL: URL accepts alternate IP forms such as 127.1.
  const match = typeof endpoint === 'string'
    ? /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(endpoint)
    : null;
  if (!match || Number(match[1]) > 65535) {
    throw new ConnectorError('INVALID_ENDPOINT', 'Use an explicit local endpoint: http://127.0.0.1:<port>.');
  }
  return new URL(endpoint);
}

export async function listTargets(endpoint, { timeoutMs = 5000 } = {}) {
  const base = validateEndpoint(endpoint);
  validateTimeout(timeoutMs);
  let response;
  let targets;
  try {
    response = await fetch(new URL('/json/list', base), {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new ConnectorError('CDP_HTTP_ERROR', `Local CDP target listing returned HTTP ${response.status}.`);
    }
    targets = await response.json();
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('CDP_UNAVAILABLE', 'Cannot read the local CDP target list; check the dedicated browser.', { cause: error });
  }
  if (!Array.isArray(targets) || targets.some(target =>
    !target || typeof target !== 'object' || Array.isArray(target)
    || typeof target.id !== 'string' || !target.id
    || typeof target.type !== 'string' || typeof target.url !== 'string')) {
    throw new ConnectorError('INVALID_TARGET_LIST', 'The local CDP response is not a valid target list.');
  }
  return targets;
}

export function isBossUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/www\.zhipin\.com(?::443)?(?:[/?#]|$)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.zhipin.com'
      && !url.username && !url.password && (!url.port || url.port === '443');
  } catch {
    return false;
  }
}

export function chooseBossTarget(targets, targetId) {
  if (!Array.isArray(targets)) throw new ConnectorError('INVALID_TARGET_LIST', 'Expected a CDP target array.');
  if (targetId !== undefined && (typeof targetId !== 'string' || !targetId)) {
    throw new ConnectorError('INVALID_TARGET_ID', 'targetId must be a non-empty string.');
  }
  const matches = targets.filter(target => target && target.type === 'page'
    && typeof target.id === 'string' && target.id && isBossUrl(target.url)
    && (targetId === undefined || target.id === targetId));
  if (!matches.length) {
    throw new ConnectorError(targetId === undefined ? 'NO_BOSS_TARGET' : 'TARGET_NOT_ALLOWED',
      targetId === undefined ? 'No HTTPS BOSS page is open in the dedicated browser.'
        : 'The requested target is absent or is not an HTTPS BOSS page.');
  }
  if (matches.length !== 1) {
    throw new ConnectorError('AMBIGUOUS_TARGET', 'Multiple matching BOSS pages exist; select exactly one target ID.');
  }
  return matches[0];
}

function validateSocketUrl(value, endpoint) {
  const base = validateEndpoint(endpoint);
  const match = typeof value === 'string'
    ? /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/devtools\/page\/[A-Za-z0-9._-]+$/.exec(value)
    : null;
  if (!match || Number(match[1]) > 65535 || Number(match[1]) !== Number(base.port || 80)) {
    throw new ConnectorError('INVALID_WEBSOCKET', 'CDP WebSocket must be a page target on the same local endpoint.');
  }
  return value;
}

export class CdpSession {
  #url;
  #timeoutMs;
  #socket;
  #state = 'new';
  #connectPromise;
  #opening;
  #pending = new Map();
  #nextId = 1;

  constructor(wsUrl, { timeoutMs = 5000, endpoint } = {}) {
    validateTimeout(timeoutMs);
    this.#url = validateSocketUrl(wsUrl, endpoint);
    this.#timeoutMs = timeoutMs;
  }

  connect() {
    if (this.#state === 'open') return Promise.resolve();
    if (this.#state === 'connecting') return this.#connectPromise;
    if (this.#state === 'closed') return Promise.reject(new ConnectorError('CDP_CLOSED', 'Create a new session after closing CDP.'));
    this.#state = 'connecting';
    this.#connectPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#shutdown(
        new ConnectorError('CDP_CONNECT_TIMEOUT', 'Timed out connecting to the local CDP page.')),
      this.#timeoutMs);
      this.#opening = { resolve, reject, timer };
      try {
        this.#socket = new WebSocket(this.#url);
        this.#socket.addEventListener('open', () => {
          if (this.#state !== 'connecting') return;
          this.#state = 'open';
          const opening = this.#opening;
          this.#opening = undefined;
          clearTimeout(opening.timer);
          opening.resolve();
        });
        this.#socket.addEventListener('message', event => this.#receive(event.data));
        this.#socket.addEventListener('close', () => this.#shutdown(
          new ConnectorError('CDP_CLOSED', 'The local CDP connection closed.')));
        this.#socket.addEventListener('error', () => this.#shutdown(
          new ConnectorError('CDP_CONNECTION_ERROR', 'The local CDP connection failed.')));
      } catch (error) {
        this.#shutdown(new ConnectorError('CDP_CONNECTION_ERROR', 'Unable to start the local CDP connection.', { cause: error }));
      }
    });
    return this.#connectPromise;
  }

  send(method, params = {}) {
    if (this.#state !== 'open') {
      return Promise.reject(new ConnectorError('CDP_CLOSED', 'CDP must be connected before sending a command.'));
    }
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)
      || !params || typeof params !== 'object' || Array.isArray(params)) {
      return Promise.reject(new ConnectorError('INVALID_COMMAND', 'Expected a CDP method and parameter object.'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ConnectorError('CDP_TIMEOUT', `CDP command ${method} timed out; its outcome may be unknown.`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new ConnectorError('CDP_SEND_FAILED', 'Unable to send the CDP command.', { cause: error }));
      }
    });
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(data);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
    } catch {
      this.#shutdown(new ConnectorError('CDP_PROTOCOL_ERROR', 'The local CDP connection returned invalid JSON data.'));
      return;
    }
    // Events and late replies do not resolve a different command.
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new ConnectorError('CDP_COMMAND_FAILED', 'The browser rejected the CDP command.'));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  #shutdown(error) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    if (this.#opening) {
      clearTimeout(this.#opening.timer);
      this.#opening.reject(error);
      this.#opening = undefined;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    try { this.#socket?.close(); } catch { /* A failed handshake may already have disposed the socket. */ }
  }

  close() {
    this.#shutdown(new ConnectorError('CDP_CLOSED', 'The local CDP session was closed.'));
  }
}
