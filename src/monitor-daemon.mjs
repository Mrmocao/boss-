import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './config.mjs';
import { MonitorStore } from './monitor-store.mjs';
import { MonitorBrowser } from './monitor-browser.mjs';
import { ingestSnapshot, dueConversations, applyModelResult, markHandoff } from './monitor-core.mjs';
import { getModelSettings, proposeReply } from './monitor-model.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
export const monitorRoot = join(projectRoot, '.local', 'monitor', 'company-2');
const commands = new Set(['pause', 'resume', 'stop', 'takeover', 'resume-conversation', 'retry-model']);
export async function readMonitorConfig() {
  const config = JSON.parse(await readFile(join(projectRoot, 'config', 'monitor.json'), 'utf8'));
  // This pilot deliberately has no send path. Reject accidental attempts to enable it.
  if (config.profile !== 'company-2' || !config.expectedAccountDisplayName || config.mode !== 'observe_and_draft'
    || config.allowSend !== false || config.allowInterview !== false || config.allowAssessment !== false
    || !Array.isArray(config.acceptedTitles) || !config.acceptedTitles.length
    || !Number.isInteger(config.maxConversations) || config.maxConversations < 1 || config.maxConversations > 3
    || !Number.isInteger(config.tickMs) || config.tickMs < 1000 || config.tickMs > 10000
    || !Number.isInteger(config.debounceMs) || config.debounceMs < 1000
    || !Number.isInteger(config.reconcileMs) || config.reconcileMs < 120000 || config.reconcileMs > 300000)
    throw Object.assign(new Error('Invalid pilot configuration'), { code:'MONITOR_CONFIG_INVALID' });
  return config;
}

export async function importSeed(store, config, folder = join(projectRoot, '.local', 'validation', 'yesterday-conversation-20261106')) {
  if (store.snapshot().imports?.singleConversationV1) return;
  let intent, prior;
  try {
    intent = JSON.parse(await readFile(join(folder, 'intent.json'), 'utf8'));
    prior = JSON.parse(await readFile(join(folder, 'state.json'), 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (intent.profile !== config.profile || intent.account.displayName !== config.expectedAccountDisplayName
    || intent.status !== 'sent_confirmed' || !config.acceptedTitles.includes(intent.candidate.jobTitle))
    throw Object.assign(new Error('Seed does not match pilot account'), { code:'SEED_MISMATCH' });
  await store.transaction(state => {
    if (state.account?.displayName && state.account.displayName !== config.expectedAccountDisplayName)
      throw Object.assign(new Error('Existing state belongs to another account'), {code:'SEED_MISMATCH'});
    const id = intent.candidate.domRowId;
    state.account ??= { ...intent.account, profile:config.profile };
    state.sentIntents[intent.id] = { ...intent, conversationId:id };
    state.conversations[id] ??= {
      id, ...intent.candidate, admitted:true, needsDetail:true, human_handoff:false,
      status:'waiting_reply', knownOutboundContents:[intent.text],
      lastOutbound:{text:intent.text, intentId:intent.id, receipt:intent.receipt},
      facts:{education_records:prior.screening.education, major:prior.screening.major, planning_intent:prior.screening.intent},
      evidence:[], questionsAsked:['current_education_stage', 'explicit_planning_interest', 'optional_games'],
      clarificationCount:prior.clarificationCount, interest:'unknown', testConsent:'unknown',
      importedAt:iso(), noInterview:true, noTest:true,
    };
    state.imports = { ...state.imports, singleConversationV1:iso() };
    state.events.push({type:'seed_imported', conversationId:id, at:iso()});
  });
}

async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', {encoding:'utf8', flag:'wx'});
  await rename(temp, path);
}

export async function queueCommand(command, conversationId, root = monitorRoot) {
  if (!commands.has(command)) throw new Error('Unknown monitor command');
  const live = await readStatus(root);
  if (!live.running) throw Object.assign(new Error('Monitor is not running'), {code:'MONITOR_OFFLINE'});
  const id = randomUUID();
  const dir = join(root, 'commands');
  await mkdir(dir, {recursive:true});
  await atomicJson(join(dir, `${id}.json`), {id, command, conversationId, createdAt:iso(), runId:live.runtime.runId});
  return id;
}

export async function readStatus(root = monitorRoot) {
  let state;
  try { state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {running:false, health:'not_started'}; throw e; }
  let running = false;
  try {
    const owner = JSON.parse(await readFile(join(root, 'daemon.lock', 'owner.json'), 'utf8'));
    process.kill(owner.pid, 0);
    running = owner.pid === state.runtime.pid;
  } catch { /* No live owner. */ }
  return {running, responsive:running && Date.now() - Date.parse(state.runtime.heartbeatAt || state.runtime.startedAt) < 90000,
    controls:state.controls, runtime:state.runtime,
    conversations:Object.values(state.conversations).filter(c => c.admitted !== false).map(c => ({
      id:c.id, name:c.name, jobTitle:c.jobTitle, status:c.status, human_handoff:c.human_handoff,
      clarificationCount:c.clarificationCount, needsDetail:c.needsDetail, pendingAt:c.pendingAt,
    })), notificationCount:state.notifications.length};
}

// Only the daemon writes the store. CLI commands use an atomic file mailbox.
export async function processCommands(store, browser, root, runId, config) {
  const dir = join(root, 'commands');
  await mkdir(dir, {recursive:true});
  await mkdir(join(root, 'receipts'), {recursive:true});
  const files = (await readdir(dir)).filter(f => /^[a-f0-9-]{36}\.json$/.test(f));
  const requests = await Promise.all(files.map(async file => {
    try { return {file, request:JSON.parse(await readFile(join(dir,file),'utf8'))}; }
    catch { return {file, request:null}; }
  }));
  requests.sort((a,b) => String(a.request?.createdAt || '').localeCompare(String(b.request?.createdAt || '')) || a.file.localeCompare(b.file));
  for (const entry of requests) {
    const {file} = entry;
    let request, receipt;
    try {
      request = entry.request;
      if (!request || !commands.has(request.command) || request.runId !== runId || request.id + '.json' !== file)
        throw Object.assign(new Error('Expired or invalid command'), {code:'COMMAND_INVALID'});
      if (request.command === 'resume-conversation') {
        const c = store.snapshot().conversations[request.conversationId];
        if (!c || c.admitted === false) throw Object.assign(new Error('Unknown conversation'), {code:'CONVERSATION_UNKNOWN'});
        await browser.resumeConversation(c);
        // Capture replies made during takeover before explicitly resetting the outgoing baseline.
        const snapshot = await browser.poll({force:true});
        const resumeConfig = config || await readMonitorConfig();
        await store.transaction(state => ingestSnapshot(state, snapshot, resumeConfig));
        if (snapshot.activity?.typing || Date.now() - (snapshot.activity?.lastHumanAt || 0) < 15000
          || [...(snapshot.activity?.humanConversationIds || []), ...(snapshot.activity?.manualConversationIds || [])].includes(c.id))
          throw Object.assign(new Error('Human input resumed during recovery'), {code:'HUMAN_ACTIVE'});
      }
      await store.transaction(state => {
        const c = state.conversations[request.conversationId];
        switch (request.command) {
          case 'pause': state.controls.paused = true; break;
          case 'resume': state.controls.paused = false; break;
          case 'stop': state.controls.stopRequested = true; break;
          case 'takeover':
            if (!c) throw Object.assign(new Error('Unknown conversation'), {code:'CONVERSATION_UNKNOWN'});
            markHandoff(state, c.id, 'explicit_manual_takeover'); break;
          case 'resume-conversation':
            c.human_handoff = false; c.status = 'waiting_reply'; c.needsDetail = true;
            delete c.handoffReason;
            const last = (c.messages || []).findLast(m => ['incoming','outgoing','unknown'].includes(m.direction));
            c.pendingAt = last?.direction === 'incoming' ? Date.now() : null;
            c.processedFingerprint = last?.direction === 'incoming' ? null : c.fingerprint;
            // Explicit resume establishes a new outgoing baseline; prior human replies stay recorded.
            c.knownOutboundContents = [...new Set([...(c.knownOutboundContents || []),
              ...(c.messages || []).filter(m => m.direction === 'outgoing').map(m => m.text).filter(Boolean)])];
            break;
          case 'retry-model':
            if (!c || c.human_handoff) throw Object.assign(new Error('Resume conversation first'), {code:'HUMAN_HANDOFF'});
            if (!c.detail || !c.fingerprint || (c.messages || []).findLast(m => ['incoming','outgoing','unknown'].includes(m.direction))?.direction !== 'incoming')
              throw Object.assign(new Error('No pending incoming message'), {code:'NO_PENDING_INCOMING'});
            c.processedFingerprint = null; c.pendingAt = Date.now(); break;
        }
        state.events.push({type:'control', command:request.command, conversationId:request.conversationId, at:iso()});
      });
      receipt = {id:request.id, command:request.command, ok:true, at:iso()};
    } catch (e) { receipt = {id:file.slice(0,-5), command:request?.command, ok:false, code:e.code || 'COMMAND_FAILED', at:iso()}; }
    await atomicJson(join(root, 'receipts', file), receipt);
    await unlink(join(dir, file));
  }
}

const cell = value => String(value ?? '—').replace(/[|\r\n]/g, ' ');
export async function writeWorkbench(state, root) {
  const lines = ['# 招聘监听工作台', '', `更新时间：${iso()}`, '',
    `运行状态：${state.runtime.health}；人工全局暂停：${!!state.controls.paused}；发送：关闭。`, '',
    '覆盖：仅网页当前渲染的会话列表和聊天窗口，未证明全量覆盖。', '',
    '|候选人|岗位|状态|人工接管|补问次数|会话 ID|', '|---|---|---|---|---|---|'];
  for (const c of Object.values(state.conversations).filter(c => c.admitted !== false))
    lines.push(`|${cell(c.name)}|${cell(c.jobTitle)}|${cell(c.status)}|${!!c.human_handoff}|${cell(c.clarificationCount)}|${cell(c.id)}|`);
  lines.push('', '## 最近本地待办', '');
  for (const n of state.notifications.slice(-20)) lines.push(`- ${cell(n.conversationId || n.id)}：${cell(n.reason || n.message || n.type)}`);
  lines.push('', '## 已记录资料与草稿', '');
  for (const c of Object.values(state.conversations).filter(c => c.admitted !== false)) {
    lines.push(`### ${cell(c.name)} / ${cell(c.jobTitle)}`, '', '```json',
      JSON.stringify({facts:c.facts, evidence:c.evidence, questionsAsked:c.questionsAsked,
        interest:c.interest, testConsent:c.testConsent, screening:c.screening, workflow:c.workflow, draft:c.draft, summary:c.summary,
        latestIncoming:(c.messages || []).filter(m => m.direction === 'incoming').slice(-5).map(m => ({text:m.text, observedTime:m.observedTime})),
        observedEducation:c.detail?.candidate?.educationText, suggestedEvidence:c.suggestedEvidence,
        note:'原始回复优先于导入的旧摘要；模型建议未经人工确认。'}, null, 2), '```', '');
  }
  const temp = join(root, 'workbench.tmp.md');
  await writeFile(temp, lines.join('\n') + '\n', 'utf8');
  await rename(temp, join(root, 'workbench.md'));
}

export async function runMonitor({once = false, root = monitorRoot, config,
  browser, model = proposeReply} = {}) {
  config ??= await readMonitorConfig();
  browser ??= new MonitorBrowser(config);
  const store = await new MonitorStore(root).init();
  const runId = randomUUID();
  let stopped = false, connected = false, lastReconcile = 0, retryAt = 0, failures = 0;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await importSeed(store, config);
    const rulesText = await readFile(resolve(projectRoot, config.rulesFile), 'utf8');
    await store.transaction(state => {
      state.controls.stopRequested = false;
      for (const c of Object.values(state.conversations))
        if (c.admitted !== false && !c.human_handoff) c.needsDetail = true;
      state.runtime = {...state.runtime, pid:process.pid, runId, startedAt:iso(), stoppedAt:null, health:'starting', mode:config.mode,
        profile:config.profile, sendEnabled:false, modelEnabled:!!config.model.enabled,
        modelReady:!!config.model.enabled && getModelSettings(config).ready};
    });
    do {
      await processCommands(store, browser, root, runId, config);
      if (store.snapshot().controls.stopRequested || stopped) break;
      try {
        if (!store.snapshot().controls.paused && Date.now() >= retryAt) {
          let snapshot;
          if (!connected) {
            await store.transaction(s => {
              for (const c of Object.values(s.conversations))
                if (c.admitted !== false && !c.human_handoff) c.needsDetail = true;
            });
            snapshot = await browser.connect(); connected = true;
          }
          else if (Date.now() - lastReconcile >= config.reconcileMs) { snapshot = await browser.scanStep(); lastReconcile = Date.now(); }
          else snapshot = await browser.poll();
          await store.transaction(s => ingestSnapshot(s, snapshot, config));
          const candidate = Object.values(store.snapshot().conversations).find(c => c.admitted !== false
            && c.needsDetail && !c.human_handoff && snapshot.rows.some(row => row.domRowId === c.domRowId));
          if (candidate && !snapshot.activity.typing && Date.now() - snapshot.activity.lastHumanAt > 15000) {
            snapshot = await browser.openConversation(candidate);
            await store.transaction(s => ingestSnapshot(s, snapshot, config));
          }
          for (const c of dueConversations(store.snapshot(), config)) {
            if (store.snapshot().controls.paused || store.snapshot().controls.stopRequested) break;
            let result;
            if (!config.model.enabled || !getModelSettings(config).ready)
              result = {status:'unconfigured', reason:'模型接口尚未配置，保留消息等待人工处理'};
            else {
              try {
                const proposal = await model({config, conversation:c, rulesText});
                result = {status:'ok', action:({handoff:'human_handoff', recommend:'summarize', stop:'human_handoff'})[proposal.action] || proposal.action,
                  draft:proposal.reply, summary:proposal.reason, evidence:proposal.evidence,
                  missingInformation:proposal.missingFields, interest:proposal.interest, testConsent:proposal.testConsent};
              } catch (e) { result = {status:'error', reason:e.code || 'MODEL_FAILED'}; }
              // New messages or human activity during the model request invalidate old proposals.
              snapshot = await browser.poll({force:true});
              await store.transaction(s => ingestSnapshot(s, snapshot, config));
              await processCommands(store, browser, root, runId, config);
            }
            if (!store.snapshot().controls.paused && !store.snapshot().controls.stopRequested)
              await store.transaction(s => applyModelResult(s, c.id, c.fingerprint, result));
          }
          failures = 0; retryAt = 0;
          await store.transaction(s => { Object.assign(s.runtime, {health:'observing', lastObservationAt:iso(),
            coverage:snapshot.coverage, targetId:browser.target?.id, lastError:null}); });
        }
      } catch (e) {
        const transient = ['OBSERVATION_CHANGED','DETAIL_CHANGED','HUMAN_ACTIVE','HUMAN_HANDOFF','CONVERSATION_MISMATCH'].includes(e.code);
        if (!transient) { await browser.close().catch(() => {}); connected = false; }
        failures++;
        retryAt = Date.now() + Math.min(30000, config.tickMs * 2 ** Math.min(failures,4));
        await store.transaction(s => {
          const code = e.code || 'MONITOR_ERROR';
          if (s.runtime.lastError !== code) s.notifications.push({type:'monitor_attention', reason:code, at:iso()});
          Object.assign(s.runtime, {health:transient ? 'waiting_stable_page' : 'disconnected', lastError:code, retryAt});
        });
      }
      await store.transaction(s => { s.runtime.heartbeatAt = iso(); if (s.controls.paused) s.runtime.health = 'paused'; });
      await writeWorkbench(store.snapshot(), root);
      if (!once && !stopped) await delay(config.tickMs);
    } while (!once && !stopped);
  } finally {
    await browser.close().catch(() => {});
    try { await store.transaction(s => { s.runtime.health = 'stopped'; s.runtime.stoppedAt = iso(); });
      await writeWorkbench(store.snapshot(), root); }
    finally { await store.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  }
}

async function main() {
  const [command = 'status', id] = process.argv.slice(2);
  if (command === 'run') return runMonitor({once:process.argv.includes('--once')});
  if (command === 'status') return console.log(JSON.stringify(await readStatus(), null, 2));
  if (commands.has(command)) {
    const requestId = await queueCommand(command, id);
    for (let i=0; i<15; i++) {
      try { const receipt = JSON.parse(await readFile(join(monitorRoot, 'receipts', `${requestId}.json`), 'utf8'));
        console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1; return; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await delay(1000);
    }
    console.log(JSON.stringify({queued:true, requestId, note:'处理尚未完成，请稍后查看 status 和 receipts'})); return;
  }
  throw new Error('Usage: monitor-daemon.mjs run [--once] | status | pause | resume | stop | takeover ID | resume-conversation ID | retry-model ID');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => { console.error(JSON.stringify({error:e.code || 'MONITOR_FAILED'})); process.exitCode = 1; });
