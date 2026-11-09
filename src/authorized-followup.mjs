// Explicit single-message execution only. This module is not imported by the daemon.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MonitorStore } from './monitor-store.mjs';
import { MonitorBrowser } from './monitor-browser.mjs';
import { monitorRoot, readMonitorConfig, writeWorkbench } from './monitor-daemon.mjs';
import { ingestSnapshot, markHandoff } from './monitor-core.mjs';

export const followupFingerprint = detail => createHash('sha256').update(JSON.stringify(
  detail.messages.filter(m => m.direction !== 'system').map(m => [m.direction,m.kind,m.text]))).digest('hex');
const fail = code => { throw Object.assign(new Error(code),{code}); };

function editorAction({action,text,expectedFingerprint,expected,guardExpression}) {
  // Replaced by fixed serialized guard at expression construction, never candidate-provided code.
  const guard = guardExpression;
  if (guard.blocked) return {blocked:guard.blocked};
  if (['domRowId','name','jobTitle'].some(k => guard.selectedRow?.[k] !== expected[k])) return {blocked:'IDENTITY_CHANGED'};
  const activity=guard.activity;
  if (Date.now()-(activity.lastHumanAt || 0)<15000 || activity.humanConversationIds?.includes(expected.domRowId)
    || activity.manualConversationIds?.includes(expected.domRowId)) return {blocked:'HUMAN_ACTIVE'};
  const visible=e=>e && e.getClientRects().length>0;
  const editors=Array.from(document.querySelectorAll('.conversation-editor #boss-chat-editor-input[contenteditable="true"]')).filter(visible);
  const buttons=Array.from(document.querySelectorAll('.conversation-editor .submit')).filter(e=>visible(e)&&e.innerText.trim()==='发送');
  if(editors.length!==1 || buttons.length!==1) return {blocked:'EDITOR_UNVERIFIED'};
  const editor=editors[0], button=buttons[0];
  const current=editor.innerText.trim();
  const messages=Array.from(document.querySelectorAll('.conversation-main .chat-message-list .message-item')).filter(visible).map(e=>{
    const friend=!!e.querySelector('.item-friend'), myself=!!e.querySelector('.item-myself'), system=!!e.querySelector('.item-system,.message-card-wrap');
    const text=e.querySelector('.text-content')?.innerText?.trim() || null;
    return [system?'system':friend&&!myself?'incoming':myself&&!friend?'outgoing':'unknown',system?'system_card':text?'text':'unknown',text];
  }).filter(m=>m[0]!=='system');
  if(JSON.stringify(messages)!==expectedFingerprint) return {blocked:'MESSAGES_CHANGED'};
  if(action==='inspect') return {editorEmpty:!current,buttonReady:!button.classList.contains('disabled')};
  if(action==='receipt') {
    const node=Array.from(document.querySelectorAll('.conversation-main .chat-message-list .message-item')).filter(visible)
      .findLast(e=>e.querySelector('.item-myself') && e.querySelector('.text-content')?.innerText.trim()===text);
    const status=node?.querySelector('.status.status-delivery,.status.status-read')?.innerText?.trim();
    return {confirmed:!!node && /^(送达|已读)$/.test(status || '') && !current,status:status || null,editorEmpty:!current};
  }
  if(action==='fill') {
    if(current) return {blocked:'DRAFT_PRESENT'};
    editor.focus(); editor.textContent=text;
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    return {filled:editor.innerText.trim()===text};
  }
  if(action==='send') {
    if(current!==text || button.classList.contains('disabled') || button.getAttribute('aria-disabled')==='true') return {blocked:'DRAFT_CHANGED'};
    button.click(); return {clicked:true};
  }
  return {blocked:'INVALID_ACTION'};
}

export function followupExpression({action,text,expected,messages,account,owner}) {
  // A controlled send must not let our own staged draft become a human takeover marker.
  // Use a pure page guard and inspect the existing observer activity without mutating it.
  const guard=`(() => {
    if(location.origin!=='https://www.zhipin.com'||location.pathname!=='/web/chat/index') return {blocked:'PAGE_CHANGED'};
    const visible=e=>e&&e.getClientRects().length>0;
    const profile=document.querySelector('.top-profile-logout .user-name');
    if(!visible(profile)||profile.innerText.trim()!==${JSON.stringify(account)}) return {blocked:'ACCOUNT_CHANGED'};
    if(Array.from(document.querySelectorAll('[role="dialog"],.dialog,.modal')).filter(visible).some(e=>/安全验证|拖动滑块|请完成验证|操作过于频繁/.test(e.innerText))) return {blocked:'VERIFICATION_SUSPECTED'};
    const row=document.querySelector('.geek-item.selected'); const root=document.querySelector('.conversation-main');
    const selectedRow={domRowId:row?.getAttribute('data-id'),name:row?.querySelector('.geek-name')?.innerText.trim(),jobTitle:row?.querySelector('.source-job')?.innerText.trim()};
    if(root?.querySelector('.base-name')?.innerText.trim()!==selectedRow.name||root?.querySelector('.position-name')?.innerText.trim()!==selectedRow.jobTitle) return {blocked:'IDENTITY_CHANGED'};
    const hook=window.__bossRecruitingMonitorV1;
    if(!hook||hook.owner!==${JSON.stringify(owner)}) return {blocked:'OBSERVER_CHANGED'};
    return {selectedRow,activity:hook};
  })()`;
  const args=JSON.stringify({action,text,expected,expectedFingerprint:JSON.stringify(messages.filter(m=>m.direction!=='system').map(m=>[m.direction,m.kind,m.text]))});
  return `(${editorAction.toString()})({...${args},guardExpression:${guard}})`;
}

export async function sendAuthorizedFollowup(request) {
  if(!request?.intentId || !request.authorization || !request.expectedFingerprint || typeof request.text!=='string'
    || request.text.length>1500 || !request.text.trim() || /https?:\/\/|面试|邀约|试题|问卷|笔试/.test(request.text)) fail('FOLLOWUP_REQUEST_INVALID');
  const config=await readMonitorConfig();
  const store=await new MonitorStore(monitorRoot).init(); // Refuses to race a running monitor.
  const browser=new MonitorBrowser(config);
  let attemptStarted=false, createdIntent=false;
  try {
    if(store.snapshot().sentIntents[request.intentId]) fail('INTENT_ALREADY_RECORDED');
    const record=store.snapshot().conversations[request.conversationId];
    if(!record?.admitted || record.human_handoff) fail('CONVERSATION_UNAVAILABLE_OR_HANDOFF');
    if((record.knownOutboundContents || []).includes(request.text)
      || Object.values(store.snapshot().sentIntents).some(i=>i.conversationId===record.id
        && (['send_attempt_started','send_unknown'].includes(i.status) || (i.text===request.text && i.status==='sent_confirmed')))) fail('DUPLICATE_OR_UNKNOWN_OUTBOUND');
    if(request.isClarification && Number(record.clarificationCount || 0)>=1 && !request.clarificationException) fail('CLARIFICATION_LIMIT');
    let snapshot=await browser.connect();
    if(snapshot.selectedRow.domRowId!==record.domRowId) snapshot=await browser.openConversation(record);
    if(snapshot.activity.typing || snapshot.activity.handoffRequired || followupFingerprint(snapshot.detail)!==request.expectedFingerprint) fail('CONTEXT_CHANGED');
    if(snapshot.detail.messages.findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))?.direction!=='incoming') fail('WAITING_FOR_PEER');
    if(snapshot.detail.messages.some(m=>m.direction==='outgoing'&&m.text===request.text)) fail('DUPLICATE_OUTBOUND');
    await store.transaction(s=>{
      ingestSnapshot(s,snapshot,config);
      if(s.conversations[record.id].human_handoff) fail('HUMAN_HANDOFF');
      s.sentIntents[request.intentId]={id:request.intentId,conversationId:record.id,text:request.text,status:'prepared',
        authorization:request.authorization,clarificationException:request.clarificationException || null,createdAt:new Date().toISOString()};
    });
    createdIntent=true;
    const act=async action=>{
      const result=await browser.session.send('Runtime.evaluate',{expression:followupExpression({action,text:request.text,
        expected:record,messages:snapshot.detail.messages,account:config.expectedAccountDisplayName,owner:browser.owner}),returnByValue:true,timeout:4000});
      const value=result.result?.value;
      if(result.exceptionDetails || !value || value.blocked) fail(value?.blocked || 'EDITOR_ACTION_FAILED');
      return value;
    };
    if(!(await act('inspect')).editorEmpty) fail('DRAFT_PRESENT');
    if(!(await act('fill')).filled) fail('FILL_FAILED');
    // Wait only for the site's input handler. Sending still revalidates all identities/content.
    await new Promise(resolve=>setTimeout(resolve,300));
    await store.transaction(s=>{s.sentIntents[request.intentId].status='send_attempt_started';s.sentIntents[request.intentId].attemptedAt=new Date().toISOString();});
    attemptStarted=true;
    await act('send');
    let after, receipt;
    for(let i=0;i<6;i++) {
      await new Promise(resolve=>setTimeout(resolve,500));
      after=await browser.poll({force:true});
      if(after.selectedRow.domRowId!==record.id) fail('IDENTITY_CHANGED');
      const result=await browser.session.send('Runtime.evaluate',{expression:followupExpression({action:'receipt',text:request.text,
        expected:record,messages:after.detail.messages,account:config.expectedAccountDisplayName,owner:browser.owner}),returnByValue:true,timeout:4000});
      const verified=result.result?.value;
      if(!result.exceptionDetails && verified?.confirmed) {
        receipt={status:verified.status,observedAt:new Date().toISOString(),source:'.status.status-delivery/.status.status-read',editorEmpty:true};break;
      }
    }
    if(!receipt) fail('SEND_RECEIPT_UNKNOWN');
    await store.transaction(s=>{
      const c=s.conversations[record.id];
      c.knownOutboundContents=[...new Set([...(c.knownOutboundContents||[]),request.text])];
      s.sentIntents[request.intentId].status='sent_confirmed';s.sentIntents[request.intentId].receipt=receipt;
      c.lastOutbound={intentId:request.intentId,text:request.text,receipt};
      if(request.isClarification)c.clarificationCount=Number(c.clarificationCount || 0)+1;
      c.questionsAsked=[...new Set([...(c.questionsAsked||[]),...(request.questionIds || [])])];
      ingestSnapshot(s,after,config);
      if(after.detail.messages.findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))?.direction==='outgoing' && !c.human_handoff) {
        c.processedFingerprint=c.fingerprint;c.pendingAt=null;c.status='waiting_reply';
      }
      s.events.push({type:'authorized_followup_sent',conversationId:c.id,intentId:request.intentId,at:new Date().toISOString()});
    });
    return {sent:true,conversationId:record.id,intentId:request.intentId,receipt};
  } catch(e) {
    await store.transaction(s=>{
      const intent=s.sentIntents[request.intentId];
      if(createdIntent && intent && intent.status!=='sent_confirmed') {intent.status=attemptStarted?'send_unknown':'not_sent';intent.error=e.code || 'FOLLOWUP_FAILED';}
      if(attemptStarted)markHandoff(s,request.conversationId,'send_unknown');
    });
    throw e;
  } finally {await browser.close();await writeWorkbench(store.snapshot(),monitorRoot);await store.close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {const request=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));console.log(JSON.stringify(await sendAuthorizedFollowup(request),null,2));}
  catch(e){console.error(JSON.stringify({error:e.code || 'FOLLOWUP_FAILED',sent:false,note:'Inspect saved intent before any retry'}));process.exitCode=1;}
}
