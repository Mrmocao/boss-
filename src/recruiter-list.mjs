import { pageProbe } from './page-status.mjs';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Fixed DOM adapter: no editor, click, keyboard, request or browser-storage access.
const observe = `(() => {
  const p = ${pageProbe};
  if (p.blocked || new URL(p.url).pathname !== '/web/chat/index') return { blocked: 'PAGE_CHANGED' };
  if (p.signals.verificationControl || p.signals.loginControl || !p.signals.recruiterAccountNavigation)
    return { blocked: 'ACCOUNT_UNVERIFIED' };
  const text = (selector, root = document) => root.querySelector(selector)?.innerText?.trim() || null;
  const list = document.querySelector('.user-list');
  if (!list || !list.clientHeight) return { blocked: 'LIST_UNAVAILABLE' };
  const account = { displayName: text('.top-profile-logout .user-name'), identityConfidence: 'display_only' };
  const filters = { category: text('.chat-label-item.selected .content'), job: text('.chat-select-job'),
    read: text('.chat-message-filter-left .active'),
    search: Array.from(document.querySelectorAll('.chat-user input')).map(e => ({placeholder:e.placeholder,value:e.value})) };
  if (!account.displayName || !filters.category || !filters.job || !filters.read) return { blocked: 'FILTER_UNVERIFIED' };
  return { account, filters, sourceUrl: new URL(p.url).origin + new URL(p.url).pathname,
    selectedRow: document.querySelector('.geek-item.selected')?.getAttribute('data-id') || null,
    windowLimitText: text('.conversation-no-data .subtitle'),
    geometry: { top:list.scrollTop, height:list.scrollHeight, client:list.clientHeight },
    footer: text('.load-tips'),
    rows: Array.from(list.querySelectorAll('.geek-item')).map(e => {
      const badge = text('.badge-count', e);
      return { domRowId:e.getAttribute('data-id'), platformCandidateId:null,
        identityConfidence:'dom_row_id_unverified', name:text('.geek-name',e), jobTitle:text('.source-job',e),
        lastMessagePreview:text('.push-text',e), displayTime:text('.time',e),
        unreadCount:badge && /^\\d+$/.test(badge) ? Number(badge) : null, unreadBadgeText:badge,
        source:'conversation_list_dom', applicationStatus:'unknown', resumeStatus:'unknown' };
    }) };
})()`;

export function contextKey(page) {
  return JSON.stringify({ account:page.account, filters:page.filters, sourceUrl:page.sourceUrl, selectedRow:page.selectedRow });
}

export function createListAdapter(session) {
  const evaluate = async expression => {
    const result = await session.send('Runtime.evaluate', { expression, returnByValue:true, timeout:4000 });
    if (result.exceptionDetails || !result.result?.value) fail('PAGE_READ_FAILED', 'Could not inspect the recruiter list.');
    if (result.result.value.blocked) fail(result.result.value.blocked, 'Recruiter list safety check failed; collection stopped.');
    return result.result.value;
  };
  return {
    read: () => evaluate(observe),
    scroll: async (top, expected) => {
      if (!Number.isFinite(top) || top < 0) fail('INVALID_SCROLL', 'Invalid list position.');
      return evaluate(`(() => {
        const p = ${observe}; if(p.blocked) return p;
        const key = JSON.stringify({account:p.account,filters:p.filters,sourceUrl:p.sourceUrl,selectedRow:p.selectedRow});
        if(key !== ${JSON.stringify(expected)}) return {blocked:'PAGE_CHANGED'};
        document.querySelector('.user-list').scrollTop = ${top};
        return {scrolled:true};
      })()`);
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 500)),
  };
}

/** Accumulate overlapping virtual-list windows; DOM IDs are only scan-local keys. */
export async function scanRecruiterList(adapter, { maxSteps = 120, maxRows = 1000 } = {}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 500 || !Number.isSafeInteger(maxRows) || maxRows < 1)
    fail('INVALID_LIMIT', 'Invalid scan limits.');
  const initial = await adapter.read(), expected = contextKey(initial);
  const rows = new Map();
  let page = initial, stopReason = 'step_limit', stable = 0, previous = '';
  let restored = false;
  const validate = next => {
    if (next.blocked || contextKey(next) !== expected) fail('PAGE_CHANGED', 'Account, filters or selected conversation changed; discard scan.');
  };
  try {
    if (initial.geometry.top > 0) {
      await adapter.scroll(0, expected); await adapter.settle(); page = await adapter.read(); validate(page);
      if (page.geometry.top > 2) fail('SCROLL_START_UNVERIFIED', 'Could not reach the start of the list; discard scan.');
    }
    for (let step = 0; step < maxSteps; step++) {
      validate(page);
      for (const row of page.rows) {
        if (!row.domRowId) fail('ROW_ID_UNAVAILABLE', 'A list row has no DOM identity; discard scan instead of silently omitting it.');
        const prior = rows.get(row.domRowId);
        if (prior && (prior.name !== row.name || prior.jobTitle !== row.jobTitle))
          fail('ROW_ID_CONFLICT', 'A DOM row ID changed identity; discard scan.');
        if (!prior && rows.size >= maxRows) { stopReason = 'row_limit'; break; }
        rows.set(row.domRowId, { ...row, sourceIndex: prior?.sourceIndex ?? rows.size + 1 });
      }
      if (stopReason === 'row_limit') break;
      const signature = JSON.stringify([page.geometry, page.footer, page.rows, rows.size]);
      stable = signature === previous ? stable + 1 : 0; previous = signature;
      const atBottom = page.geometry.top + page.geometry.client >= page.geometry.height - 2;
      if (stable >= 3) {
        stopReason = atBottom && /^(没有更多了|没有更多|暂无更多|已加载全部|已全部加载)$/.test(page.footer || '')
          ? 'explicit_end' : atBottom ? 'loaded_end_unconfirmed' : 'scroll_stalled';
        break;
      }
      if (step + 1 === maxSteps) break;
      await adapter.scroll(page.geometry.top + Math.max(100, Math.floor(page.geometry.client * 0.8)), expected);
      await adapter.settle(); page = await adapter.read();
    }
    const final = await adapter.read(); validate(final);
    if (JSON.stringify([final.geometry, final.footer, final.rows]) !== JSON.stringify([page.geometry, page.footer, page.rows]))
      fail('LIST_CHANGED', 'The final list window changed; discard scan and retry when stable.');
    // Restore only under the same visible account/filter/conversation context.
    await adapter.scroll(initial.geometry.top, expected); await adapter.settle();
    const afterRestore = await adapter.read(); validate(afterRestore);
    restored = Math.abs(afterRestore.geometry.top - initial.geometry.top) < 2;
    return {
      account:initial.account, sourceUrl:initial.sourceUrl, collectedAt:new Date().toISOString(), rows:[...rows.values()],
      scope:{ type:'conversation_list', filters:initial.filters, windowLimitText:initial.windowLimitText,
        historyCoverage:'unknown', formalApplications:'unverified', stablePlatformIds:'unverified',
        completeness:stopReason === 'explicit_end' ? 'current_filter_end_observed' : 'partial_or_unknown',
        stopReason, finalFooter:page.footer, maxSteps, maxRows, scrollRestored:restored,
        conversationDetailsRead:false, messagesSent:0, conversationsOpened:0,
        sideEffects:['list_scroll_and_lazy_load'], missingRowId:false },
    };
  } catch (error) {
    // A changed page/account must not receive a cleanup action in an unrelated context.
    throw error;
  }
}
