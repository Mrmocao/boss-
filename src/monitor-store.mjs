import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 2000;
const MAX_NOTIFICATIONS = 500;

function error(code, message, options) { return Object.assign(new Error(message, options), { code }); }
function clone(value) { return structuredClone(value); }
function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, account: null, conversations: {}, events: [], notifications: [],
    controls: { paused: false, stopRequested: false }, runtime: {}, sentIntents: {} };
}
function ensureShape(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schemaVersion !== SCHEMA_VERSION
      || !state.conversations || typeof state.conversations !== 'object' || Array.isArray(state.conversations)
      || !Array.isArray(state.events) || !Array.isArray(state.notifications)
      || !state.controls || typeof state.controls !== 'object' || Array.isArray(state.controls)
      || !state.sentIntents || typeof state.sentIntents !== 'object' || Array.isArray(state.sentIntents))
    throw error('STATE_INVALID', 'Durable monitor state has an unsupported shape; refusing to continue.');
  return state;
}
function ownerIsAlive(owner) {
  try { process.kill(owner.pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; if (e.code === 'EPERM') return true; throw error('LOCK_STALE_UNCLEAR', 'Could not verify monitor lock owner; refusing takeover.', { cause:e }); }
}

export class MonitorStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw error('INVALID_STORE_ROOT', 'rootDir must be a non-empty path.');
    this.rootDir = rootDir;
    this.statePath = join(rootDir, 'state.json');
    this.lockPath = join(rootDir, 'daemon.lock');
    this.state = null;
    this.lockToken = null;
    this.closed = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.closed) throw error('STORE_CLOSED', 'Create a new store instance after close().');
    if (this.state) return this;
    await mkdir(this.rootDir, { recursive: true });
    await this.#acquireLock();
    try {
      let loaded;
      let stateWasMissing = false;
      try { loaded = JSON.parse(await readFile(this.statePath, 'utf8')); }
      catch (e) {
        if (e.code === 'ENOENT') { loaded = defaultState(); stateWasMissing = true; }
        else if (e instanceof SyntaxError) throw error('STATE_CORRUPT', 'Durable monitor state is not valid JSON; refusing to overwrite it.', { cause:e });
        else throw e;
      }
      this.state = ensureShape(loaded);
      const recovered = [];
      for (const [intentId, intent] of Object.entries(this.state.sentIntents)) {
        if (!intent || intent.status !== 'send_attempt_started') continue;
        intent.status = 'send_unknown';
        intent.recoveredAt = new Date().toISOString();
        if (intent.conversationId && this.state.conversations[intent.conversationId]) {
          this.state.conversations[intent.conversationId].human_handoff = true;
          this.state.conversations[intent.conversationId].status = 'human_review';
        }
        recovered.push({ intentId, conversationId:intent.conversationId ?? null });
      }
      if (recovered.length) {
        this.#trim(this.state);
        this.state.events.push(...recovered.map(item => ({ type:'send_unknown_recovered', ...item, observedAt:new Date().toISOString() })));
        this.#trim(this.state);
        await this.#persist(this.state);
      } else if (stateWasMissing) await this.#persist(this.state);
      return this;
    } catch (e) {
      this.state = null;
      await this.#releaseLock().catch(() => {});
      this.lockToken = null;
      throw e;
    }
  }

  snapshot() {
    if (!this.state) throw error('STORE_NOT_INITIALIZED', 'Call init() before snapshot().');
    return clone(this.state);
  }

  async transaction(fn) {
    if (typeof fn !== 'function') throw error('INVALID_TRANSACTION', 'transaction requires a function.');
    if (!this.state || this.closed) throw error('STORE_NOT_INITIALIZED', 'Call init() before transaction().');
    const run = async () => {
      const draft = clone(this.state);
      const result = await fn(draft);
      ensureShape(draft);
      this.#trim(draft);
      await this.#persist(draft);
      this.state = draft;
      return result;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.#releaseLock();
    this.lockToken = null;
  }

  #trim(state) {
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    if (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.splice(0, state.notifications.length - MAX_NOTIFICATIONS);
  }

  async #persist(state) {
    const temp = join(this.rootDir, `.state.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx');
      await handle.writeFile(JSON.stringify(state, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temp, this.statePath);
    } catch (e) {
      await handle?.close().catch(() => {});
      await rm(temp, { force:true }).catch(() => {});
      throw error('STATE_PERSIST_FAILED', 'Could not durably persist monitor state; previous state remains active.', { cause:e });
    }
  }

  async #acquireLock() {
    this.lockToken = randomUUID();
    const payload = { pid:process.pid, token:this.lockToken, startedAt:new Date().toISOString(), schemaVersion:1 };
    try {
      await mkdir(this.lockPath);
      await writeFile(join(this.lockPath, 'owner.json'), JSON.stringify(payload) + '\n', { encoding:'utf8', flag:'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw error('LOCK_FAILED', 'Could not acquire monitor lock.', { cause:e });
    }
    let owner;
    try { owner = JSON.parse(await readFile(join(this.lockPath, 'owner.json'), 'utf8')); }
    catch (e) { throw error('LOCK_CORRUPT', 'Monitor lock exists but its owner record is invalid; refusing to take it over.', { cause:e }); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) {
      throw error('LOCK_CORRUPT', 'Monitor lock owner record is malformed; refusing to take it over.');
    }
    if (ownerIsAlive(owner)) throw error('LOCK_HELD', `Monitor is already running under PID ${owner.pid}.`);
    // Serialize stale-lock recovery so a second process cannot delete the new owner's lock.
    const reclaimPath = join(this.rootDir, 'daemon.reclaim.lock');
    try { await mkdir(reclaimPath); }
    catch (e) { throw error('LOCK_STALE_UNCLEAR', 'Another recovery may be active; refusing simultaneous lock takeover.', { cause:e }); }
    try {
      const current = JSON.parse(await readFile(join(this.lockPath, 'owner.json'), 'utf8'));
      if (current.pid !== owner.pid || current.token !== owner.token || ownerIsAlive(current))
        throw error('LOCK_HELD', 'Monitor owner changed during lock recovery.');
      await rm(this.lockPath, { recursive:true, force:false });
      await mkdir(this.lockPath);
      await writeFile(join(this.lockPath, 'owner.json'), JSON.stringify(payload) + '\n', { encoding:'utf8', flag:'wx' });
    } finally { await rm(reclaimPath, { recursive:true, force:true }); }
  }

  async #releaseLock() {
    if (!this.lockToken) return;
    let owner;
    try { owner = JSON.parse(await readFile(join(this.lockPath, 'owner.json'), 'utf8')); } catch { return; }
    if (owner?.token !== this.lockToken || owner?.pid !== process.pid) return;
    await rm(this.lockPath, { recursive:true, force:true });
  }
}
