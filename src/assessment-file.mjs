import {open,readFile,mkdir,writeFile} from 'node:fs/promises';
import {basename,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {projectRoot} from './config.mjs';
import {followupExpression} from './authorized-followup.mjs';
import {ingestSnapshot,markHandoff} from './monitor-core.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function prepareAssessmentFile(filePath,outbox=resolve(projectRoot,'.local/assessment-outbox')) {
  if(typeof filePath!=='string'||!isAbsolute(filePath)||!/\.xlsx$/i.test(filePath))fail('ASSESSMENT_FILE_INVALID');
  const handle=await open(filePath,'r');let bytes;
  try{const meta=await handle.stat();if(!meta.isFile()||meta.size<4||meta.size>10_000_000)fail('ASSESSMENT_FILE_SIZE');bytes=await handle.readFile();}finally{await handle.close();}
  if(bytes.length>10_000_000||bytes.subarray(0,4).toString('hex')!=='504b0304')fail('ASSESSMENT_FILE_INVALID');
  const checksum=hash(bytes),name=basename(filePath),folder=resolve(outbox,checksum);
  await mkdir(folder,{recursive:true});const path=resolve(folder,name);
  try{await writeFile(path,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  if(hash(await readFile(path))!==checksum)fail('ASSESSMENT_COPY_CHANGED');
  return {path,name,size:bytes.length,sha256:checksum};
}

/** Pure probe, except an explicit confirmed file preview's send click. No invented upload input. */
export function filePageAction({action,expected,account,owner,file,before=0}) {
  const blocked=code=>({blocked:code});
  const visible=e=>e&&e.getClientRects().length>0;
  if(location.origin!=='https://www.zhipin.com'||location.pathname!=='/web/chat/index')return blocked('PAGE_CHANGED');
  if(document.querySelector('.top-profile-logout .user-name')?.innerText.trim()!==account)return blocked('ACCOUNT_CHANGED');
  const row=document.querySelector('.geek-item.selected'),root=document.querySelector('.conversation-main');
  if(row?.getAttribute('data-id')!==expected.id||row.querySelector('.geek-name')?.innerText.trim()!==expected.name
    ||row.querySelector('.source-job')?.innerText.trim()!==expected.jobTitle||root?.querySelector('.base-name')?.innerText.trim()!==expected.name||root?.querySelector('.position-name')?.innerText.trim()!==expected.jobTitle)return blocked('IDENTITY_CHANGED');
  const hook=window.__bossRecruitingMonitorV1;
  if(!hook||hook.owner!==owner||Date.now()-(hook.lastHumanAt||0)<15000||hook.humanConversationIds.includes(expected.id))return blocked('HUMAN_ACTIVE');
  if(Array.from(document.querySelectorAll('[role="dialog"],.dialog,.modal')).filter(visible).some(e=>/安全验证|操作过于频繁|拖动滑块/.test(e.innerText)))return blocked('VERIFICATION_SUSPECTED');
  const editor=document.querySelector('.conversation-editor #boss-chat-editor-input');
  if(!editor||editor.innerText.trim())return blocked('DRAFT_PRESENT');
  const fileNodes=Array.from(root.querySelectorAll('.chat-message-list .message-item')).filter(visible).filter(e=>{
    if(!e.querySelector('.item-myself'))return false;
    return Array.from(e.querySelectorAll('.file-name,.file-title,.attachment-name,a[download]')).some(n=>(n.getAttribute('download')||n.innerText||'').trim()===file.name);
  });
  if(action==='receipt'){
    const node=fileNodes.length===before+1?fileNodes.at(-1):null;
    const status=node?.querySelector('.status.status-delivery,.status.status-read')?.innerText.trim();
    return {confirmed:!!node&&/^(送达|已读)$/.test(status||''),status:status||null,count:fileNodes.length};
  }
  if(action==='confirm_preview'){
    const dialogs=Array.from(document.querySelectorAll('[role="dialog"],.dialog,.modal')).filter(visible).filter(e=>e.innerText.includes(file.name)&&e.innerText.includes(expected.name));
    if(dialogs.length!==1)return {clicked:false};
    const buttons=Array.from(dialogs[0].querySelectorAll('button,[role="button"],.boss-btn')).filter(b=>visible(b)&&b.innerText.trim()==='发送'&&!b.disabled);
    if(buttons.length!==1)return {clicked:false};buttons[0].click();return {clicked:true};
  }
  const inputs=Array.from(document.querySelectorAll('.conversation-operate input[type="file"]')).filter(e=>{
    if(e.disabled||e.files?.length)return false;
    const accept=(e.accept||'').toLowerCase();
    return (!accept||accept.includes('.xlsx')||accept.includes('spreadsheetml'))&&!accept.startsWith('image/');
  });
  if(inputs.length!==1)return blocked('FILE_UPLOAD_UNAVAILABLE');
  if(action==='input')return inputs[0];
  return {available:true,existingFiles:fileNodes.length};
}

export async function executeAssessmentFile({store,browser,config,conversationId,fingerprint,plan,processControls=async()=>{},textSender,clock=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms)),outbox}) {
  if(plan.type!=='send_file'||plan.messageId!=='S3'||config.mode!=='automatic'||!config.allowSend||!config.allowAssessment)fail('ASSESSMENT_NOT_ALLOWED');
  const file=await prepareAssessmentFile(config.assessment.filePath,outbox);
  const id='file-'+hash(conversationId+'|'+plan.receiptToken+'|'+file.sha256).slice(0,32);
  let attempted=false,prepared=false;
  const check=()=>{
    const state=store.snapshot(),c=state.conversations[conversationId];
    if(!c?.admitted||c.human_handoff||state.controls.paused||state.controls.stopRequested||state.runtime.humanActive||c.needsDetail||c.fingerprint!==fingerprint)fail('CONTEXT_CHANGED');
    if(!['waiting_consent','test_pending'].includes(c.workflow?.stage)||c.analysis?.consent?.value!=='yes')fail('CONSENT_REQUIRED');
    if(!Object.values(state.sentIntents).some(i=>i.conversationId===c.id&&i.messageId==='S1'&&i.status==='sent_confirmed'))fail('S1_RECEIPT_REQUIRED');
    if((c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))?.direction!=='incoming')fail('WAITING_FOR_PEER');
    if(clock()-(c.lastInboundObservedAt??c.pendingAt??clock())<Math.max(30000,config.debounceMs||0))fail('QUIET_PERIOD_PENDING');
    if(state.sentIntents[id]||Object.values(state.sentIntents).some(i=>i.conversationId===c.id&&['send_attempt_started','send_unknown'].includes(i.status)))fail('FILE_ALREADY_ATTEMPTED');
    return c;
  };
  let c=check();let snapshot;
  const args={expected:{id:c.id,name:c.name,jobTitle:c.jobTitle},account:config.expectedAccountDisplayName,owner:browser.owner,file};
  const page=async(action,before=0,returnByValue=true)=>{
    const result=await browser.session.send('Runtime.evaluate',{expression:`(${filePageAction.toString()})(${JSON.stringify({...args,action,before})})`,returnByValue,timeout:4000});
    if(result.exceptionDetails||result.result?.value?.blocked)fail(result.result?.value?.blocked||'FILE_PAGE_CHECK_FAILED');
    return result.result;
  };
  try{
    snapshot=await browser.poll({force:true});if(snapshot.selectedRow?.domRowId!==c.id)snapshot=await browser.openConversation(c);
    await store.transaction(s=>ingestSnapshot(s,snapshot,config,clock()));await processControls();c=check();
    const capability=(await page('inspect')).value;if(!capability?.available)fail('FILE_UPLOAD_UNAVAILABLE');
    if(capability.existingFiles)fail('FILE_ALREADY_VISIBLE');
    const node=await page('input',0,false);
    if(node?.subtype!=='node'||!node.objectId)fail('FILE_INPUT_UNVERIFIED');
    const described=await browser.session.send('DOM.describeNode',{objectId:node.objectId});
    if(described.node?.nodeName!=='INPUT')fail('FILE_INPUT_UNVERIFIED');
    const guard=await browser.session.send('Runtime.evaluate',{expression:followupExpression({action:'inspect',text:'',expected:c,messages:snapshot.detail.messages,account:config.expectedAccountDisplayName,owner:browser.owner}),returnByValue:true});
    if(guard.exceptionDetails||guard.result?.value?.blocked||!guard.result?.value?.editorEmpty)fail(guard.result?.value?.blocked||'CONTEXT_CHANGED');
    await processControls();check();
    await store.transaction(s=>{s.sentIntents[id]={id,conversationId,messageId:'S3_FILE',kind:'assessment_file',file:{name:file.name,size:file.size,sha256:file.sha256},status:'send_attempt_started',createdAt:new Date().toISOString()};});prepared=true;
    // Selecting a file can auto-upload/send on this platform, so the attempt is durable first.
    attempted=true;await browser.session.send('DOM.setFileInputFiles',{files:[file.path],backendNodeId:described.node.backendNodeId});
    let receipt,clicked=false;
    for(let i=0;i<30;i++){
      await delay(500);await processControls();
      const value=(await page('receipt',capability.existingFiles)).value;
      if(value?.confirmed){receipt={status:value.status,fileName:file.name,fileSha256:file.sha256,observedAt:new Date().toISOString()};break;}
      const live=store.snapshot();if(live.controls.paused||live.controls.stopRequested||live.conversations[c.id]?.human_handoff)fail('FILE_TRANSFER_INTERRUPTED');
      if(!clicked){
        const g=await browser.session.send('Runtime.evaluate',{expression:followupExpression({action:'inspect',text:'',expected:c,messages:snapshot.detail.messages,account:config.expectedAccountDisplayName,owner:browser.owner}),returnByValue:true});
        if(g.result?.value?.blocked||g.exceptionDetails)fail(g.result?.value?.blocked||'CONTEXT_CHANGED');
        clicked=(await page('confirm_preview')).value?.clicked===true;
      }
    }
    if(!receipt)fail('FILE_RECEIPT_UNKNOWN');
    const after=await browser.poll({force:true});
    if(after.selectedRow?.domRowId!==c.id)fail('IDENTITY_CHANGED');
    await store.transaction(s=>{
      Object.assign(s.sentIntents[id],{status:'sent_confirmed',receipt});const record=s.conversations[c.id];
      record.knownOutboundContents=[...new Set([...(record.knownOutboundContents||[]),file.name])];
      ingestSnapshot(s,after,config,clock());record.workflow.stage='assessment_file_sent';record.workflow.receiptToken=plan.receiptToken;
      record.pendingAssessment={fileIntentId:id,fingerprint:record.fingerprint,text:plan.text,receiptToken:plan.receiptToken,fileSha256:file.sha256};
      s.events.push({type:'assessment_file_delivered',conversationId:c.id,intentId:id,at:new Date().toISOString()});
    });
    const current=store.snapshot().conversations[c.id];
    const beforeIncoming=JSON.stringify(snapshot.detail.messages.filter(m=>m.direction==='incoming').map(m=>m.text));
    const afterIncoming=JSON.stringify(after.detail.messages.filter(m=>m.direction==='incoming').map(m=>m.text));
    if(beforeIncoming!==afterIncoming)fail('NEW_INCOMING_AFTER_FILE');
    return await textSender({store,browser,config,conversationId:c.id,fingerprint:current.fingerprint,plan:{...plan,type:'send',delivery:'file',fileIntentId:id},processControls,clock,delay});
  }catch(e){
    await store.transaction(s=>{
      if(prepared&&s.sentIntents[id].status!=='sent_confirmed')s.sentIntents[id].status=attempted?'send_unknown':'not_sent';
      markHandoff(s,conversationId,e.code==='FILE_UPLOAD_UNAVAILABLE'?'当前BOSS会话未提供可核验的文件上传入口，请人工处理':attempted?'试题文件发送或回收说明未全部确认，请核对，禁止重发文件':(e.code||'文件发送检查失败'));
    });throw e;
  }
}
