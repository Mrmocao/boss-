import {createHash} from 'node:crypto';
import {markHandoff} from './monitor-core.mjs';

export async function rejectResumeRequest({store,browser,conversation,config}) {
  const request=(conversation.detail?.attachmentRequests||[]).find(r=>r.status==='pending');
  if(!request)return {rejected:false};
  const id='attachment-'+createHash('sha256').update(conversation.id+'|'+request.index+'|'+request.text).digest('hex').slice(0,32);
  if(store.snapshot().sentIntents[id])throw Object.assign(new Error('附件操作已记录，需核对'),{code:'ATTACHMENT_ALREADY_RECORDED'});
  await store.transaction(s=>{s.sentIntents[id]={id,conversationId:conversation.id,status:'send_attempt_started',kind:'attachment_rejection',createdAt:new Date().toISOString()};});
  try {
    const probe=await browser.evaluate();
    if(probe.selectedRow.domRowId!==conversation.id||probe.activity.typing||probe.activity.handoffRequired)throw new Error('CONTEXT_CHANGED');
    const action=({account,candidate,request,owner})=>{
      const visible=e=>e&&e.getClientRects().length>0;
      if(location.origin!=='https://www.zhipin.com'||location.pathname!=='/web/chat/index')return {blocked:true};
      if(document.querySelector('.top-profile-logout .user-name')?.innerText.trim()!==account||document.querySelector('.geek-item.selected')?.getAttribute('data-id')!==candidate.id)return {blocked:true};
      const hook=window.__bossRecruitingMonitorV1;
      if(!hook||hook.owner!==owner||Date.now()-(hook.lastHumanAt||0)<15000||hook.humanConversationIds.includes(candidate.id))return {blocked:true};
      const root=document.querySelector('.conversation-main');
      if(root?.querySelector('.base-name')?.innerText.trim()!==candidate.name||root?.querySelector('.position-name')?.innerText.trim()!==candidate.jobTitle)return {blocked:true};
      const cards=[...root.querySelectorAll('.message-card-wrap')].filter(visible);
      const card=cards[request.index];if(!card||card.innerText.trim()!==request.text||!/简历/.test(card.innerText))return {blocked:true};
      const buttons=[...card.querySelectorAll('button,a,[role="button"],.btn')].filter(b=>visible(b)&&/^(拒绝|拒收)$/.test(b.innerText.trim()));
      if(buttons.length!==1)return {blocked:true};buttons[0].click();return {clicked:true};
    };
    const candidate={id:conversation.id,name:conversation.name,jobTitle:conversation.jobTitle};
    const result=await browser.session.send('Runtime.evaluate',{expression:`(${action.toString()})(${JSON.stringify({account:config.expectedAccountDisplayName,candidate,request,owner:browser.owner})})`,returnByValue:true});
    if(!result.result?.value?.clicked)throw new Error('ATTACHMENT_ACTION_UNVERIFIED');
    await new Promise(r=>setTimeout(r,700));
    const check=await browser.session.send('Runtime.evaluate',{expression:`(()=>{const r=document.querySelector('.conversation-main');if(document.querySelector('.geek-item.selected')?.getAttribute('data-id')!==${JSON.stringify(conversation.id)})return false;const e=Array.from(r.querySelectorAll('.message-card-wrap')).filter(e=>e.getClientRects().length>0)[${request.index}];return !!e&&/简历/.test(e.innerText)&&/已拒绝|已拒收/.test(e.innerText)&&!${JSON.stringify(request.text)}.match(/已拒绝|已拒收/);})()`,returnByValue:true});
    if(check.result?.value!==true)throw new Error('ATTACHMENT_RECEIPT_UNKNOWN');
    await store.transaction(s=>{s.sentIntents[id].status='sent_confirmed';s.sentIntents[id].receipt={status:'已拒绝',observedAt:new Date().toISOString()};});
    return {rejected:true,id};
  }catch(e){await store.transaction(s=>{s.sentIntents[id].status='send_unknown';markHandoff(s,conversation.id,'附件拒收未确认，禁止重复操作');});throw e;}
}
