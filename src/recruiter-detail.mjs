import { pageProbe } from './page-status.mjs';
import { isBossUrl } from './cdp.mjs';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

const detailProbe = `(() => {
  const p = ${pageProbe};
  if (p.blocked || new URL(p.url).pathname !== '/web/chat/index') return { blocked: 'PAGE_CHANGED' };
  if (p.signals.verificationControl || p.signals.loginControl || !p.signals.recruiterAccountNavigation)
    return { blocked: 'ACCOUNT_UNVERIFIED' };
  const visible = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const listRow = document.querySelector('.geek-item.selected');
  const conversation = document.querySelector('.conversation-main');
  const name = conversation?.querySelector('.base-name')?.innerText?.trim() || null;
  const job = conversation?.querySelector('.position-name')?.innerText?.trim() || null;
  const id = listRow?.getAttribute('data-id') || null;
  const text = (selector, root = conversation) => root?.querySelector(selector)?.innerText?.trim() || null;
  if (!listRow || !conversation || !name || !job || !id) return { blocked: 'CONVERSATION_UNAVAILABLE' };
  if (text('.geek-name',listRow) !== name || text('.source-job',listRow) !== job) return { blocked:'CONVERSATION_MISMATCH' };
  const infoText = text('.base-info-single-container');
  const expectText = text('.position-item.expect');
  const history = text('.base-info-single-main');
  const messageItems = Array.from(conversation.querySelectorAll('.chat-message-list .message-item'))
    .map((e, index) => {
      if (!visible(e)) return null;
      const friend = !!e.querySelector('.item-friend');
      const myself = !!e.querySelector('.item-myself');
      const system = !!e.querySelector('.item-system,.message-card-wrap');
      const content = e.querySelector('.text-content')?.innerText?.trim() || null;
      const timestamp = e.querySelector('.message-time')?.innerText?.trim() || null;
      const raw = e.innerText?.trim() || '';
      return { localIndex:index, direction:system ? 'system' : friend && !myself ? 'incoming' : myself && !friend ? 'outgoing' : 'unknown',
        kind:system ? 'system_card' : content ? 'text' : 'unknown', text:content, displayText:raw.slice(0,4000),
        observedTime:timestamp, identityConfidence:'dom_order_unverified', sourceLocator:'.chat-message-list .message-item', sourceDomIndex:index };
    }).filter(Boolean);
  const resumeButton = Array.from(conversation.querySelectorAll('.resume-btn-online')).find(visible);
  return { account:{displayName:document.querySelector('.top-profile-logout .user-name')?.innerText?.trim() || null, identityConfidence:'display_only'},
    selected:{domRowId:id,name,jobTitle:job}, candidate:{name, summaryText:infoText, profileText:history, expectedText:expectText,
      educationText:(history || '').split(/\\n/).map(x => x.trim()).filter(x => /·.*·\\s*(?:本科|硕士|博士|大专|专科)/.test(x)), onlineResumeVisible:!!resumeButton, attachmentButtonVisible:!!conversation.querySelector('.resume-btn-file')},
    messages:messageItems, readWindow:{loadedCount:messageItems.length, oldestVisible:messageItems[0]?.observedTime || null,
      newestVisible:messageItems.at(-1)?.observedTime || null, hasOlderUnloaded:'unknown', hasNewerUnloaded:'unknown'},
    sideEffects:['may_mark_read'], sourceUrl:new URL(p.url).origin+new URL(p.url).pathname };
})()`;

export async function readSelectedConversation(session, expected) {
  const before = await session.send('Target.getTargetInfo', { targetId: expected.targetId });
  if (!isBossUrl(before.targetInfo?.url)) fail('TARGET_CHANGED', 'The target left the allowed BOSS origin.');
  const result = await session.send('Runtime.evaluate', { expression: detailProbe, returnByValue:true, timeout:5000 });
  if (result.exceptionDetails || !result.result?.value) fail('PAGE_READ_FAILED', 'Could not read the selected conversation.');
  const data = result.result.value;
  if (data.blocked) fail(data.blocked, 'Conversation detail safety check failed.');
  if (data.selected.domRowId !== expected.domRowId || data.selected.name !== expected.name || data.selected.jobTitle !== expected.jobTitle)
    fail('CONVERSATION_MISMATCH', 'Selected conversation changed; discard this observation.');
  if (data.account.displayName !== expected.accountDisplayName) fail('ACCOUNT_CHANGED', 'Account display name changed during detail read.');
  const after = await session.send('Target.getTargetInfo', { targetId: expected.targetId });
  if (after.targetInfo?.url !== before.targetInfo?.url) fail('TARGET_CHANGED', 'Page changed during detail read.');
  const last = await session.send('Runtime.evaluate', { expression: detailProbe, returnByValue:true, timeout:5000 });
  const verified = last.result?.value;
  if (last.exceptionDetails || !verified || verified.blocked ||
      JSON.stringify(verified.account) !== JSON.stringify(data.account) ||
      JSON.stringify(verified.selected) !== JSON.stringify(data.selected))
    fail('CONVERSATION_MISMATCH', 'Account or conversation changed during read; discard this observation.');
  if (JSON.stringify(verified.messages) !== JSON.stringify(data.messages) ||
      JSON.stringify(verified.candidate) !== JSON.stringify(data.candidate))
    fail('DETAIL_CHANGED', 'Messages or profile changed during read; retry after the page settles.');
  return data;
}

export { detailProbe };
