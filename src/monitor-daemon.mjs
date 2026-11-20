import { readFile, writeFile, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { projectRoot, profilePorts } from './config.mjs';
import { MonitorStore,renameWithRetry } from './monitor-store.mjs';
import { MonitorBrowser } from './monitor-browser.mjs';
import { ingestSnapshot, dueConversations, applyModelResult, markHandoff } from './monitor-core.mjs';
import { getModelSettings, proposeReply } from './monitor-model.mjs';
import { applySkillConfig } from './skill-config.mjs';
import {loadWorkflowPolicy,planWorkflow,recoverWorkflow,recordPlan,incomingBatch,questionnaireUrl,questionnaireExpiresAt} from './recruiting-workflow.mjs';
import {analyzeWorkflow} from './workflow-model.mjs';
import {executeServicePlan} from './service-sender.mjs';
import {rejectResumeRequest} from './attachment-action.mjs';
import {consumeMailbox} from './mail-receipts.mjs';
import {executeAssessmentFile} from './assessment-file.mjs';
import {shouldInspectConversation} from './recent-conversations.mjs';
import {assessmentRevision} from './dashboard-settings.mjs';
import {reviewIdleHandoff,HUMAN_REPLY_TIMEOUT_MS} from './handoff-recovery.mjs';
import {archiveInactiveConversations} from './conversation-retention.mjs';
import {readJobProfiles,contextForJob} from './job-settings.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
export const monitorRootForProfile = profile => join(projectRoot, '.local', 'monitor', profile);
const configuredProfile = (() => {
  try {
    const config = JSON.parse(readFileSync(join(projectRoot, 'config', 'monitor.json'), 'utf8'));
    return Object.hasOwn(profilePorts, config.profile) ? config.profile : 'company-2';
  } catch { return 'company-2'; }
})();
export const monitorRoot = monitorRootForProfile(configuredProfile);
const commands = new Set(['pause', 'resume', 'stop', 'takeover', 'resume-conversation', 'retry-model','human-reply','human-draft']);
export async function readMonitorConfig(configPath = join(projectRoot, 'config', 'monitor.json')) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const automatic=config.mode==='automatic';
  if(config.autoResumeHandoff!==undefined&&typeof config.autoResumeHandoff!=='boolean')throw Object.assign(new Error('Invalid recovery policy'),{code:'MONITOR_CONFIG_INVALID'});
  if(config.humanReplyTimeoutMs!==undefined&&(!Number.isInteger(config.humanReplyTimeoutMs)||config.humanReplyTimeoutMs<HUMAN_REPLY_TIMEOUT_MS))throw Object.assign(new Error('Recovery timeout must be at least ten minutes'),{code:'MONITOR_CONFIG_INVALID'});
  if (!Object.hasOwn(profilePorts, config.profile) || !config.expectedAccountDisplayName || !['observe_and_draft','automatic'].includes(config.mode)
    || config.allowSend !== automatic || config.allowInterview !== false || (typeof config.allowAssessment!=='boolean')
    || !Array.isArray(config.acceptedTitles) || !config.acceptedTitles.length
    || !Number.isInteger(config.maxConversations) || config.maxConversations < 1 || config.maxConversations > (automatic?1000:3)
    || !Number.isInteger(config.tickMs) || config.tickMs < 1000 || config.tickMs > 10000
    || !Number.isInteger(config.debounceMs) || config.debounceMs < (automatic?30000:1000)
    || !Number.isInteger(config.reconcileMs) || config.reconcileMs < 120000 || config.reconcileMs > 300000)
    throw Object.assign(new Error('Invalid pilot configuration'), { code:'MONITOR_CONFIG_INVALID' });
  const effective=await applySkillConfig(config, projectRoot);
  if(config.mode!=='automatic')return effective;
  const jobProfiles=await readJobProfiles();
  return {...effective,jobProfiles,acceptedTitles:jobProfiles.jobs.flatMap(job=>job.acceptedTitles)};
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
  await renameWithRetry(temp, path);
}

export async function queueCommand(command, conversationId, root = monitorRoot, payload = {}) {
  if (!commands.has(command)) throw new Error('Unknown monitor command');
  const live = await readStatus(root);
  if (!live.running) throw Object.assign(new Error('Monitor is not running'), {code:'MONITOR_OFFLINE'});
  const id = randomUUID();
  const dir = join(root, 'commands');
  await mkdir(dir, {recursive:true});
  if(command==='human-reply' && (typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>1500||typeof payload.fingerprint!=='string'))throw Object.assign(new Error('Invalid reply'),{code:'INVALID_REPLY'});
  if(command==='human-draft'&&typeof payload.hasDraft!=='boolean')throw Object.assign(new Error('Invalid draft activity'),{code:'INVALID_DRAFT_ACTIVITY'});
  await atomicJson(join(dir, `${id}.json`), {id, command, conversationId, text:payload.text, fingerprint:payload.fingerprint,hasDraft:payload.hasDraft, createdAt:iso(), runId:live.runtime.runId});
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
          case 'human-draft':
            if(!c?.admitted||typeof request.hasDraft!=='boolean')throw Object.assign(new Error('Invalid draft activity'),{code:'INVALID_DRAFT_ACTIVITY'});
            if(!c.human_handoff&&request.hasDraft)markHandoff(state,c.id,'explicit_manual_takeover');
            c.handoff={...c.handoff,draftPresent:request.hasDraft,lastActivityAt:iso(),reviewVersion:(c.handoff?.reviewVersion||0)+1};break;
          case 'human-reply':
            if(!c?.human_handoff||c.fingerprint!==request.fingerprint||typeof request.text!=='string'||!request.text.trim()||request.text.length>1500)throw Object.assign(new Error('Reply context changed'),{code:'REPLY_CONTEXT_CHANGED'});
            c.humanReply={id:request.id,text:request.text.trim(),fingerprint:request.fingerprint,queuedAt:iso()};
            c.handoff={...c.handoff,replyQueued:true,draftPresent:false,lastActivityAt:iso(),reviewVersion:(c.handoff?.reviewVersion||0)+1};break;
          case 'pause': state.controls.paused = true; break;
          case 'resume': state.controls.paused = false; break;
          case 'stop': state.controls.stopRequested = true; break;
          case 'takeover':
            if (!c) throw Object.assign(new Error('Unknown conversation'), {code:'CONVERSATION_UNKNOWN'});
            markHandoff(state, c.id, 'explicit_manual_takeover'); break;
          case 'resume-conversation':
            c.human_handoff = false; c.status = 'waiting_reply'; c.needsDetail = true;
            c.handoff={...c.handoff,resolvedAt:iso(),replyQueued:false,draftPresent:false,autoResumeBlocked:false,reviewVersion:(c.handoff?.reviewVersion||0)+1};delete c.humanReply;
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
    `运行状态：${state.runtime.health}；人工全局暂停：${!!state.controls.paused}；自动发送：${state.runtime.sendEnabled?'开启':'关闭'}。`, '',
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
  await renameWithRetry(temp, join(root, 'workbench.md'));
}

export async function runMonitor({once = false, root = monitorRoot, config,
  browser, model = proposeReply, analyzer=analyzeWorkflow, sender=executeServicePlan, policy} = {}) {
  config ??= await readMonitorConfig();
  browser ??= new MonitorBrowser(config);
  const store = await new MonitorStore(root).init();
  const runId = randomUUID();
  let stopped = false, connected = false, lastReconcile = 0, retryAt = 0, failures = 0;
  let lastMailRead=0;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if(config.mode==='automatic')policy??=await loadWorkflowPolicy();
    await importSeed(store, config);
    const rulesText = await readFile(resolve(projectRoot, config.rulesFile), 'utf8');
    await store.transaction(state => {
      state.controls.stopRequested = false;
      archiveInactiveConversations(state,config);
      for (const c of Object.values(state.conversations))
        if (c.admitted !== false) {
          if(c.human_handoff&&!c.handoff?.openedAt)c.handoff={...c.handoff,openedAt:iso()};
          c.needsDetail=true;if(config.mode==='automatic'){recoverWorkflow(c,state.sentIntents);if(c.pendingAt!==null)c.pendingAt=Date.now();}
        }
      state.runtime = {...state.runtime, pid:process.pid, runId, startedAt:iso(), stoppedAt:null, health:'starting', mode:config.mode,
        profile:config.profile, sendEnabled:config.mode==='automatic'&&config.allowSend, modelEnabled:!!config.model.enabled,
        handoffAutoResumeEnabled:config.autoResumeHandoff===true,humanReplyTimeoutMs:config.humanReplyTimeoutMs||HUMAN_REPLY_TIMEOUT_MS,
        modelReady:!!config.model.enabled && getModelSettings(config).ready,
        capabilities:config.mode==='automatic'?{quietPeriodMs:config.debounceMs,assessmentDelivery:config.assessment?.delivery||'file',assessmentFileConfigured:!!config.assessment?.filePath,assessmentLinkReady:!!questionnaireUrl(config),assessmentExpiresAt:questionnaireExpiresAt(config),mailbox:'awaiting_configuration'}:undefined};
    });
    do {
      if(config.jobProfiles){
        const profiles=await readJobProfiles();
        if(config.jobProfiles.revision!==profiles.revision){
          const previous=config;
          config={...config,jobProfiles:profiles,acceptedTitles:profiles.jobs.flatMap(job=>job.acceptedTitles)};
          await store.transaction(s=>{
            for(const c of Object.values(s.conversations)){
              if(c.status!=='blocked_config'||c.workflow?.stage!=='test_pending'||c.human_handoff)continue;
              const before=contextForJob(previous,policy,c.jobTitle),after=contextForJob(config,policy,c.jobTitle);
              if(after.policy.job&&before.config.assessment?.url!==after.config.assessment?.url){
                c.needsDetail=true;c.pendingAt=Date.now();c.processedFingerprint=null;
              }
            }
          });
        }
      }
      if(config.model?.configFile){
        try{
          const latest=await applySkillConfig(config,projectRoot),before=assessmentRevision(config.assessment),revision=assessmentRevision(latest.assessment),workflowChanged=JSON.stringify(config.workflow||{})!==JSON.stringify(latest.workflow||{});
          if(before!==revision||workflowChanged){
            config={...config,assessment:latest.assessment,workflow:latest.workflow};
            await store.transaction(s=>{
              s.runtime.assessmentRevision=revision;
              s.runtime.workflowConfigRevision=workflowChanged?JSON.stringify(latest.workflow||{}).length:null;
              s.runtime.capabilities={...s.runtime.capabilities,assessmentDelivery:config.assessment?.delivery,assessmentFileConfigured:!!config.assessment?.filePath,assessmentLinkReady:!!questionnaireUrl(config),assessmentExpiresAt:questionnaireExpiresAt(config)};
              for(const c of Object.values(s.conversations))if(c.status==='blocked_config'&&c.workflow?.stage==='test_pending'&&!c.human_handoff){c.needsDetail=true;c.pendingAt=Date.now();c.processedFingerprint=null;}
            });
          }else if(!store.snapshot().runtime.assessmentRevision)await store.transaction(s=>{s.runtime.assessmentRevision=revision;});
        }catch{ /* Keep last valid config; settings UI reports parse/save errors separately. */ }
      }
      await processCommands(store, browser, root, runId, config);
      if (store.snapshot().controls.stopRequested || stopped) break;
      await store.transaction(s=>archiveInactiveConversations(s,config));
      if(config.mode==='automatic'&&Date.now()-lastMailRead>15000){try{await consumeMailbox(store);lastMailRead=Date.now();}catch{await store.transaction(s=>{s.runtime.mailbox={status:'read_error'};});}}
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
          await store.transaction(s => {ingestSnapshot(s, snapshot, config);archiveInactiveConversations(s,config);if(snapshot.coverage?.scanStopReason)s.runtime.lastScan={...snapshot.coverage,checkedAt:iso()};});
          if(config.mode==='automatic'&&config.autoResumeHandoff){
            const recovery=await reviewIdleHandoff({store,browser,config,policy,analyzer,processControls:()=>processCommands(store,browser,root,runId,config)});
            if(recovery.reviewed){snapshot=await browser.poll({force:true});await store.transaction(s=>ingestSnapshot(s,snapshot,config));}
          }
          const candidate = Object.values(store.snapshot().conversations).find(c => c.admitted !== false
            && config.acceptedTitles.includes(c.jobTitle) && c.needsDetail && shouldInspectConversation(c,config) && (!c.human_handoff||c.humanReply) && snapshot.rows.some(row => row.domRowId === c.domRowId));
          if (candidate && !snapshot.activity.typing && Date.now() - snapshot.activity.lastHumanAt > 15000) {
            snapshot = await browser.openConversation(candidate);
            await store.transaction(s => ingestSnapshot(s, snapshot, config));
          }
          for (const c of dueConversations(store.snapshot(), config)) {
            if (store.snapshot().controls.paused || store.snapshot().controls.stopRequested) break;
            await store.transaction(s=>{s.runtime.heartbeatAt=iso();});
            if(config.mode==='automatic') {
              try {
                if(snapshot.selectedRow?.domRowId!==c.id){snapshot=await browser.openConversation(c);await store.transaction(s=>ingestSnapshot(s,snapshot,config));}
                let current=store.snapshot().conversations[c.id];
                if(!dueConversations(store.snapshot(),config).some(x=>x.id===c.id))continue;
                const fingerprint=current.fingerprint;
                let analysis;
                if(/薪资|薪酬|工资|奖金|待遇|加班|几薪|双休|社保|公积金/.test(incomingBatch(current))) {
                  await store.transaction(s=>markHandoff(s,c.id,'薪资或公司政策问题，等待人工回复'));continue;
                }
                const {config:jobConfig,policy:jobPolicy}=contextForJob(config,policy,current.jobTitle);
                analysis=await analyzer({config:jobConfig,conversation:current,policy:jobPolicy});
                snapshot=await browser.poll({force:true});await store.transaction(s=>ingestSnapshot(s,snapshot,config));
                await processCommands(store,browser,root,runId,config);
                current=store.snapshot().conversations[c.id];
                if(current.fingerprint!==fingerprint||!dueConversations(store.snapshot(),config).some(x=>x.id===c.id))continue;
                const plan=planWorkflow(current,analysis,jobPolicy,jobConfig,store.snapshot().sentIntents);
                await store.transaction(s=>recordPlan(s,c.id,fingerprint,plan,analysis));
                if(plan.type==='reject_attachment') {
                  await rejectResumeRequest({store,browser,conversation:current,config});
                  snapshot=await browser.poll({force:true});await store.transaction(s=>ingestSnapshot(s,snapshot,config));
                  await store.transaction(s=>{const c=s.conversations[current.id];c.pendingAttachmentGuidance={nextStage:plan.nextStage};c.pendingAt=Date.now();c.lastInboundObservedAt=Date.now();c.processedFingerprint=null;});
                  const fresh=store.snapshot().conversations[c.id];
                  if(incomingBatch(fresh)!==incomingBatch(current))continue;
                  // Attachment cards may be the only incoming event; send guard refuses ambiguous direction.
                  await sender({store,browser,config:jobConfig,conversationId:c.id,fingerprint:fresh.fingerprint,plan:{...plan,type:'send'},processControls:()=>processCommands(store,browser,root,runId,config)});
                } else if(plan.type==='send_file')await executeAssessmentFile({store,browser,config:jobConfig,conversationId:c.id,fingerprint,plan,textSender:sender,processControls:()=>processCommands(store,browser,root,runId,config)});
                else if(plan.type==='send')await sender({store,browser,config:jobConfig,conversationId:c.id,fingerprint,plan,processControls:()=>processCommands(store,browser,root,runId,config)});
              } catch(e) {
                if(!['CONTEXT_CHANGED','QUIET_PERIOD_PENDING','WAITING_FOR_PEER','OBSERVATION_CHANGED','DETAIL_CHANGED','CONVERSATION_MISMATCH','HUMAN_ACTIVE'].includes(e.code))await store.transaction(s=>{if(!s.conversations[c.id]?.human_handoff)markHandoff(s,c.id,e.code||'自动处理异常');});
              }
              continue;
            }
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
          if(config.mode==='automatic')for(const c of Object.values(store.snapshot().conversations).filter(c=>c.human_handoff&&c.humanReply)) {
            if(Date.now()-(c.lastInboundObservedAt||Date.now())<config.debounceMs)continue;
            try {
              if(snapshot.selectedRow?.domRowId!==c.id)snapshot=await browser.openConversation(c);
              const plan={type:'send',messageId:'HUMAN',humanReply:true,text:c.humanReply.text,nextStage:c.workflow?.stage||'screening'};
              await sender({store,browser,config,conversationId:c.id,fingerprint:c.humanReply.fingerprint,plan,processControls:()=>processCommands(store,browser,root,runId,config)});
              await store.transaction(s=>{delete s.conversations[c.id].humanReply;});
            }catch(e){await store.transaction(s=>{delete s.conversations[c.id].humanReply;s.conversations[c.id].handoff.replyQueued=false;markHandoff(s,c.id,'人工回复未发送或结果待核对：'+(e.code||'FAILED'));});}
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
      await store.transaction(s => { s.runtime.jobProfilesRevision=config.jobProfiles?.revision;s.runtime.heartbeatAt = iso();s.runtime.recentWindowHours=config.recentWindowHours||null;s.runtime.recentQueueCount=Object.values(s.conversations).filter(c=>c.admitted&&!c.human_handoff&&shouldInspectConversation(c,config)).length; if (s.controls.paused) s.runtime.health = 'paused'; });
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
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const id = args[1];
  const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const profile = option('--profile');
  const root = option('--root') || (profile ? monitorRootForProfile(profile) : monitorRoot);
  const configPath = option('--config');
  const config = configPath ? await readMonitorConfig(configPath) : undefined;
  if (command === 'run') return runMonitor({once:args.includes('--once'),root,config});
  if (command === 'status') return console.log(JSON.stringify(await readStatus(root), null, 2));
  if (commands.has(command)) {
    const requestId = await queueCommand(command, id, root);
    for (let i=0; i<15; i++) {
      try { const receipt = JSON.parse(await readFile(join(root, 'receipts', `${requestId}.json`), 'utf8'));
        console.log(JSON.stringify(receipt)); if (!receipt.ok) process.exitCode = 1; return; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await delay(1000);
    }
    console.log(JSON.stringify({queued:true, requestId, note:'处理尚未完成，请稍后查看 status 和 receipts'})); return;
  }
  throw new Error('Usage: monitor-daemon.mjs run|status [--profile PROFILE] [--root ROOT] [--config CONFIG]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e => { console.error(JSON.stringify({error:e.code || 'MONITOR_FAILED'})); process.exitCode = 1; });
