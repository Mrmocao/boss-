import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectorError, CdpSession, listTargets, chooseBossTarget, isBossUrl } from './cdp.mjs';
import { loadConfig } from './config.mjs';
import { createListAdapter } from './recruiter-list.mjs';
import { readSelectedConversation } from './recruiter-detail.mjs';
import { resolveRecruiterTarget } from './browser-registry.mjs';

const HOOK = '__bossRecruitingMonitorV1';
const HUMAN_IDLE_MS = 15_000;
const COVERAGE = Object.freeze({ list:'visible_window_only', history:'unknown', stableIds:'unverified', fullScan:false });
const fail = (code, message) => { throw new ConnectorError(code, message); };

// Serialized into the page. Only DOM observations and an explicitly guarded row click are allowed.
function pageMonitor({ expectedAccount, owner, action, row, humanIdleMs }) {
  const currentUrl = new URL(location.href);
  if (currentUrl.origin !== 'https://www.zhipin.com' || currentUrl.username || currentUrl.password
      || currentUrl.pathname !== '/web/chat/index') return { blocked:'PAGE_CHANGED' };
  const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = (s, root = document) => root?.querySelector(s)?.innerText?.trim() || null;
  const profile = document.querySelector('.top-profile-logout .user-name');
  const account = text('.top-profile-logout .user-name');
  if (!visible(profile) || !account || account !== expectedAccount) return { blocked:'ACCOUNT_CHANGED' };
  const nav = (path, label) => Array.from(document.querySelectorAll('a')).some(e => {
    if (!visible(e) || !e.innerText.trim().startsWith(label)) return false;
    try { const u = new URL(e.getAttribute('href'), currentUrl); return u.origin === currentUrl.origin && u.pathname === path && !u.username && !u.password; }
    catch { return false; }
  });
  if (!nav('/web/chat/job/list','职位管理') || !nav('/web/chat/geek/manage_v2','牛人管理') || !nav('/web/chat/index','沟通'))
    return { blocked:'ACCOUNT_UNVERIFIED' };
  if (Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(visible)
    .some(e => /^(扫码登录|短信登录|验证码登录|密码登录|登录注册|登录\/注册)$/.test(e.innerText.trim()))) return { blocked:'LOGIN_SUSPECTED' };
  if (Array.from(document.querySelectorAll('[role="dialog"],.dialog,.modal')).filter(visible)
    .some(e => /安全验证|拖动滑块|请完成验证|请完成下方验证|操作过于频繁/.test(e.innerText))) return { blocked:'VERIFICATION_SUSPECTED' };
  const list = document.querySelector('.user-list');
  const selected = document.querySelector('.geek-item.selected');
  const id = selected?.getAttribute('data-id');
  const selectedRow = id ? { domRowId:id, name:text('.geek-name',selected), jobTitle:text('.source-job',selected) } : null;
  if (!list || !list.clientHeight) return { blocked:'LIST_UNAVAILABLE' };
  if (!selectedRow?.name || !selectedRow.jobTitle) return { blocked:'CONVERSATION_UNAVAILABLE' };
  const conversation = document.querySelector('.conversation-main');
  if (text('.base-name',conversation) !== selectedRow.name || text('.position-name',conversation) !== selectedRow.jobTitle)
    return { blocked:'CONVERSATION_MISMATCH' };
  const key = '__bossRecruitingMonitorV1';
  const roots = '.user-list,.conversation-main,.conversation-editor,.chat-conversation,.top-profile-logout,.chat-label-item,.chat-select-job,.chat-message-filter-left,.chat-user';
  const editorSelector = '[contenteditable]:not([contenteditable="false"]),textarea,input:not([type="hidden"])';
  let state = window[key];
  const installed = !state;
  if (!state) {
    state = { version:1, owner, epoch:Date.now() + '-' + Math.random(), revision:0, lastChangeAt:Date.now(),
      lastHumanAt:0, lastInputAt:0, lastInputConversationId:null, manualSelection:false, humanConversationIds:[], manualConversationIds:[] };
    const mark = (field, value) => { if (value && !state[field].includes(value)) state[field].push(value); };
    const selectedId = () => document.querySelector('.geek-item.selected')?.getAttribute('data-id');
    state.onHuman = event => {
      if (!event.isTrusted) return;
      const element = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
      if (!element?.closest(roots)) return;
      state.lastHumanAt = Date.now();
      state.revision++;
      if (element.closest('.conversation-main,.conversation-editor,.chat-conversation') && element.closest(editorSelector)) {
        state.lastInputAt = Date.now();
        state.lastInputConversationId = selectedId();
        mark('humanConversationIds',selectedId());
      }
      const clickedRow = element.closest('.geek-item');
      if (clickedRow && (event.type === 'pointerdown' || event.type === 'keydown')) {
        state.manualSelection = true;
        mark('manualConversationIds',clickedRow.getAttribute('data-id'));
      }
    };
    for (const kind of ['input','keydown','pointerdown']) document.addEventListener(kind,state.onHuman,true);
    const relevant = node => {
      const e = node?.nodeType === 1 ? node : node?.parentElement;
      return !!e && (!!e.closest?.(roots) || !!e.querySelector?.(roots));
    };
    state.observer = new MutationObserver(records => {
      if (records.some(r => relevant(r.target) || Array.from(r.addedNodes || []).some(relevant) || Array.from(r.removedNodes || []).some(relevant))) {
        state.revision++; state.lastChangeAt = Date.now();
      }
    });
    // Filtered body observation also detects replacement of the watched list/message containers.
    state.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:['class','data-id','aria-selected','hidden']});
    window[key] = state;
  }
  if (state.version !== 1) return { blocked:'OBSERVER_INCOMPATIBLE' };
  if (action === 'close' && state.owner !== owner) return { blocked:'OBSERVER_OWNER_CHANGED' };
  state.owner = owner;
  // The live recruiter editor is a sibling of .conversation-main, not its descendant.
  // Restrict lookup to conversation containers so list-search text is never treated as a draft.
  const editorRoots = [conversation,...document.querySelectorAll('.conversation-editor')];
  const editors = [...new Set(editorRoots.flatMap(root => Array.from(root.querySelectorAll(editorSelector))))];
  const hasDraft = editors.filter(visible)
    .some(e => String(e.value ?? e.innerText ?? '').trim().length > 0);
  const typing = hasDraft || (state.lastInputConversationId === id && state.lastInputAt > 0 && Date.now() - state.lastInputAt < humanIdleMs);
  // A draft restored by Chrome or present before the listener started is still human work.
  // Preserve only its existence, never copy the draft text into monitoring state.
  if (hasDraft && !state.humanConversationIds.includes(id)) {
    state.humanConversationIds.push(id);
    state.revision++;
  }
  if (action === 'close') {
    state.observer.disconnect();
    for (const kind of ['input','keydown','pointerdown']) document.removeEventListener(kind,state.onHuman,true);
    delete window[key];
    return { closed:true };
  }
  if (action === 'open' || action === 'resume') {
    if (typing || (state.lastHumanAt > 0 && Date.now() - state.lastHumanAt < humanIdleMs)) return { blocked:'HUMAN_ACTIVE' };
    if (action === 'resume') {
      if (selectedRow.domRowId !== row.domRowId || selectedRow.name !== row.name || selectedRow.jobTitle !== row.jobTitle)
        return { blocked:'CONVERSATION_MISMATCH' };
      state.humanConversationIds = state.humanConversationIds.filter(id => id !== row.domRowId);
      state.manualConversationIds = state.manualConversationIds.filter(id => id !== row.domRowId);
      state.manualSelection = state.manualConversationIds.length > 0;
      state.revision++;
      return { resumed:true };
    }
    if (state.humanConversationIds.includes(row.domRowId) || state.manualConversationIds.includes(row.domRowId))
      return { blocked:'HUMAN_HANDOFF' };
    const matches = Array.from(list.querySelectorAll('.geek-item')).filter(e => e.getAttribute('data-id') === row.domRowId);
    if (matches.length !== 1 || !visible(matches[0]) || text('.geek-name',matches[0]) !== row.name || text('.source-job',matches[0]) !== row.jobTitle)
      return { blocked:'CONVERSATION_MISMATCH' };
    if (selectedRow.domRowId !== row.domRowId) matches[0].click();
    return { opened:true, sideEffects:['may_mark_read'] };
  }
  const handoffRequired = typing || state.humanConversationIds.includes(id) || state.manualConversationIds.includes(id);
  return { account:{ displayName:account, identityConfidence:'display_only' }, selectedRow, epoch:state.epoch, installed,
    listWindow:{ atTop:Number.isFinite(list.scrollTop) && list.scrollTop <= 2, scrollTop:Number.isFinite(list.scrollTop) ? list.scrollTop : null },
    activity:{ typing, hasDraft, handoffRequired, handoffReason:handoffRequired ? (hasDraft ? 'draft_or_typing' : 'manual_interaction') : null,
      lastHumanAt:state.lastHumanAt, manualSelection:state.manualSelection, revision:state.revision,
      lastChangeAt:state.lastChangeAt, humanConversationIds:[...state.humanConversationIds], manualConversationIds:[...state.manualConversationIds] } };
}

export function monitorExpression(args) {
  return `(${pageMonitor.toString()})(${JSON.stringify({ humanIdleMs:HUMAN_IDLE_MS, ...args })})`;
}

/** Dedicated-browser adapter. Observation never opens a conversation implicitly. */
export class MonitorBrowser {
  constructor({ profile, expectedAccountDisplayName, targetId }, dependencies = {}) {
    if (typeof expectedAccountDisplayName !== 'string' || !expectedAccountDisplayName.trim())
      fail('ACCOUNT_REQUIRED','An explicit expected account display name is required.');
    if (typeof profile !== 'string' || !profile) fail('PROFILE_REQUIRED','An explicit browser profile is required.');
    this.profile = profile;
    this.expectedAccountDisplayName = expectedAccountDisplayName;
    this.targetId = targetId;
    this.owner = randomUUID();
    this.deps = { loadConfig, readFile, listTargets, chooseBossTarget, resolveRecruiterTarget, CdpSession, createListAdapter,
      readSelectedConversation, now:Date.now, settle:() => new Promise(resolve => setTimeout(resolve,500)), ...dependencies };
    this.session = null;
    this.cache = null;
    this.lastFullRead = 0;
    this.lastProbe = null;
  }

  async connect() {
    if (this.session) fail('ALREADY_CONNECTED','Close the previous connection before reconnecting.');
    const config = this.deps.loadConfig({ ...process.env, BOSS_PROFILE:this.profile });
    let record;
    try { record = JSON.parse(await this.deps.readFile(join(config.runtimeDir,'launch.json'),'utf8')); }
    catch { fail('LAUNCH_RECORD_REQUIRED','A valid dedicated-browser launch record is required.'); }
    if (record.profile !== this.profile || record.endpoint !== config.endpoint || record.profileDir !== config.profileDir)
      fail('LAUNCH_RECORD_MISMATCH','Dedicated-browser launch record does not match the selected profile.');
    const {target,binding} = await this.deps.resolveRecruiterTarget({config,
      expectedAccountDisplayName:this.expectedAccountDisplayName,targetId:this.targetId});
    this.binding = binding;
    this.target = target;
    this.session = new this.deps.CdpSession(target.webSocketDebuggerUrl,{ endpoint:config.endpoint });
    try {
      await this.session.connect();
      this.adapter = this.deps.createListAdapter(this.session);
      this.cache = null;
      this.lastProbe = null;
      return await this.poll();
    } catch (error) { this.session.close(); this.session = null; throw error; }
  }

  async evaluate(action = 'poll', row) {
    if (!this.session) fail('NOT_CONNECTED','Connect the monitor browser first.');
    const target = await this.session.send('Target.getTargetInfo',{ targetId:this.target.id });
    if (!isBossUrl(target.targetInfo?.url) || new URL(target.targetInfo.url).pathname !== '/web/chat/index')
      fail('TARGET_CHANGED','The monitored target left the recruiter conversation page.');
    const result = await this.session.send('Runtime.evaluate',{ expression:monitorExpression({
      expectedAccount:this.expectedAccountDisplayName, owner:this.owner, action, row }), returnByValue:true, timeout:4000 });
    if (result.exceptionDetails || !result.result?.value) fail('PAGE_READ_FAILED','The browser monitor probe failed.');
    if (result.result.value.blocked) fail(result.result.value.blocked,'Browser monitor safety check failed.');
    return result.result.value;
  }

  async poll({ force = false } = {}) {
    const probe = await this.evaluate();
    const prior = this.lastProbe;
    const observerReset = !!prior && (probe.installed || prior.epoch !== probe.epoch);
    const selectionChanged = JSON.stringify(probe.selectedRow) !== JSON.stringify(prior?.selectedRow);
    const fullRead = force || !this.cache || observerReset || selectionChanged
      || probe.activity.revision !== prior?.activity.revision || this.deps.now() - this.lastFullRead >= 10_000;
    if (fullRead) {
      const list = await this.adapter.read();
      if (list.account?.displayName !== this.expectedAccountDisplayName) fail('ACCOUNT_CHANGED','Account changed during list read.');
      const selected = list.rows.filter(row => row.domRowId === list.selectedRow);
      if (selected.length !== 1 || selected[0].domRowId !== probe.selectedRow.domRowId
          || selected[0].name !== probe.selectedRow.name || selected[0].jobTitle !== probe.selectedRow.jobTitle)
        fail('CONVERSATION_MISMATCH','Selected list row changed during observation.');
      const detail = await this.deps.readSelectedConversation(this.session,{ targetId:this.target.id,
        accountDisplayName:this.expectedAccountDisplayName, ...probe.selectedRow });
      const after = await this.evaluate();
      if (after.epoch !== probe.epoch || JSON.stringify(after.selectedRow) !== JSON.stringify(probe.selectedRow))
        fail('CONVERSATION_MISMATCH','Browser context changed during observation.');
      if (after.activity.revision !== probe.activity.revision)
        fail('OBSERVATION_CHANGED','Browser content or human activity changed during observation; retry a fresh read.');
      this.cache = { account:list.account, rows:list.rows, selectedRow:probe.selectedRow, detail,
        filters:list.filters, coverage:{...COVERAGE, topWindowObserved:probe.listWindow?.atTop === true}, sideEffects:['may_mark_read'] };
      this.lastFullRead = this.deps.now();
      this.lastProbe = probe;
      return { ...structuredClone(this.cache), activity:{...after.activity,observerReset}, changed:true };
    }
    this.lastProbe = probe;
    return { ...structuredClone(this.cache), coverage:{...this.cache.coverage,topWindowObserved:probe.listWindow?.atTop === true},
      activity:{...probe.activity,observerReset}, changed:false };
  }

  async openConversation(row) {
    if (!row || !['domRowId','name','jobTitle'].every(k => typeof row[k] === 'string' && row[k]))
      fail('INVALID_CONVERSATION','A complete observed row identity is required.');
    await this.evaluate('open',{domRowId:row.domRowId,name:row.name,jobTitle:row.jobTitle});
    await this.deps.settle();
    const observation = await this.poll({force:true});
    if (['domRowId','name','jobTitle'].some(k => observation.selectedRow[k] !== row[k]))
      fail('CONVERSATION_MISMATCH','The requested conversation did not become selected.');
    return observation;
  }

  async sendText() { fail('MONITOR_SEND_DISABLED','Continuous message sending is disabled in this phase.'); }

  // Call only after an explicit human resume command; never clear sticky handoff on a timer.
  async resumeConversation(row) {
    if (!row || !['domRowId','name','jobTitle'].every(k => typeof row[k] === 'string' && row[k]))
      fail('INVALID_CONVERSATION','A complete observed row identity is required.');
    return this.evaluate('resume',{domRowId:row.domRowId,name:row.name,jobTitle:row.jobTitle});
  }

  // Bounded reconciliation only. Virtual-list history and hidden conversations remain unverified.
  async scanStep() { return this.poll({force:true}); }

  async close() {
    if (!this.session) return;
    try { await this.evaluate('close'); } catch { /* A disconnected or changed page receives no cleanup actions. */ }
    finally { this.session.close(); this.session = null; this.cache = null; this.lastProbe = null; }
  }
}

export { HOOK as MONITOR_HOOK_KEY };
