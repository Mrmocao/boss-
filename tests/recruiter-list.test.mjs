import test from 'node:test';
import assert from 'node:assert/strict';
import { contextKey, createListAdapter, scanRecruiterList } from '../src/recruiter-list.mjs';

const row = (id, name = `Candidate ${id}`) => ({
  domRowId: id, name, jobTitle: 'Unity', lastMessagePreview: 'Hello', displayTime: '昨天',
  platformCandidateId: null, identityConfidence: 'dom_row_id_unverified',
});
const frame = (rows, top = 0, extra = {}) => ({
  account: { displayName: 'Recruiter test', identityConfidence: 'display_only' },
  filters: { category: '全部', job: '全部职位', read: '全部', search: [] },
  sourceUrl: 'https://www.zhipin.com/web/chat/index', selectedRow: null,
  windowLimitText: '列表只展示近30天的联系人',
  geometry: { top, height: 300, client: 100 }, footer: '滚动加载更多', rows, ...extra,
});

function mockAdapter(frames, { onRead } = {}) {
  let index = 0, reads = 0;
  const scrolls = [];
  return {
    scrolls,
    read: async () => structuredClone(onRead?.(frames[index], ++reads) ?? frames[index]),
    scroll: async (top, expected) => {
      assert.equal(expected, contextKey(frames[index]));
      scrolls.push(top);
      index = top === frames[0].geometry.top ? 0 : Math.min(index + 1, frames.length - 1);
    },
    settle: async () => {},
  };
}

test('overlapping virtual windows accumulate contacts once and preserve same names with distinct row IDs', async () => {
  const adapter = mockAdapter([
    frame([row('a', 'Same name'), row('b', 'Same name')]),
    frame([row('b', 'Same name'), row('c')], 100),
    frame([row('c'), row('d')], 200, { footer: '没有更多了' }),
  ]);
  const result = await scanRecruiterList(adapter);
  assert.deepEqual(result.rows.map(r => r.domRowId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.rows.map(r => r.sourceIndex), [1, 2, 3, 4]);
  assert.equal(result.scope.stopReason, 'explicit_end');
  assert.equal(result.scope.completeness, 'current_filter_end_observed');
  assert.equal(result.scope.historyCoverage, 'unknown');
  assert.equal(result.scope.scrollRestored, true);
  assert.equal(result.scope.messagesSent, 0);
  assert.equal(result.scope.conversationsOpened, 0);
  assert.equal(adapter.scrolls.at(-1), 0);
});

test('loaded bottom without an explicit end remains incomplete', async () => {
  const result = await scanRecruiterList(mockAdapter([
    frame([row('a')], 0, { geometry: { top: 0, height: 100, client: 100 } }),
  ]));
  assert.equal(result.scope.stopReason, 'loaded_end_unconfirmed');
  assert.equal(result.scope.completeness, 'partial_or_unknown');
});

test('scroll that makes no progress above the bottom reports stalled', async () => {
  const result = await scanRecruiterList(mockAdapter([frame([row('a')])]));
  assert.equal(result.scope.stopReason, 'scroll_stalled');
  assert.equal(result.scope.completeness, 'partial_or_unknown');
});

test('ignored initial reset fails instead of collecting only the tail of the list', async () => {
  const adapter = mockAdapter([frame([row('tail')], 100)]);
  await assert.rejects(scanRecruiterList(adapter), { code: 'SCROLL_START_UNVERIFIED' });
  assert.deepEqual(adapter.scrolls, [0]);
});

test('a scan started partway down first collects from the top and restores the original position', async () => {
  let top = 100;
  const scrolls = [];
  const frames = [
    frame([row('a')]), frame([row('b')], 100),
    frame([row('c')], 200, { footer: '没有更多了' }),
  ];
  const adapter = {
    read: async () => structuredClone(frames[top / 100]),
    scroll: async (requested, expected) => {
      assert.equal(expected, contextKey(frames[top / 100]));
      scrolls.push(requested);
      top = Math.min(requested, 200);
    },
    settle: async () => {},
  };
  const result = await scanRecruiterList(adapter);
  assert.deepEqual(result.rows.map(r => r.domRowId), ['a', 'b', 'c']);
  assert.equal(scrolls[0], 0);
  assert.equal(scrolls.at(-1), 100);
  assert.equal(top, 100);
  assert.equal(result.scope.scrollRestored, true);
  assert.equal(result.scope.stopReason, 'explicit_end');
});

test('row limit does not claim all contacts were collected', async () => {
  const result = await scanRecruiterList(mockAdapter([frame([row('a'), row('b'), row('c')])]), { maxRows: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.scope.stopReason, 'row_limit');
  assert.equal(result.scope.completeness, 'partial_or_unknown');
});

test('step limit stores only observed windows and reports partial', async () => {
  const result = await scanRecruiterList(mockAdapter([
    frame([row('a')]), frame([row('b')], 100), frame([row('c')], 200),
  ]), { maxSteps: 2 });
  assert.deepEqual(result.rows.map(r => r.domRowId), ['a', 'b']);
  assert.equal(result.scope.stopReason, 'step_limit');
});

for (const [label, change] of [
  ['account', { account: { displayName: 'Other recruiter', identityConfidence: 'display_only' } }],
  ['filters', { filters: { category: '沟通中', job: '全部职位', read: '全部', search: [] } }],
  ['selected conversation', { selectedRow: 'unexpected-person' }],
  ['page', { sourceUrl: 'https://www.zhipin.com/web/chat/job/list' }],
]) {
  test(`${label} change discards scan and does not perform a restoration action`, async () => {
    const adapter = mockAdapter([frame([row('a')]), frame([row('b')], 100, change)]);
    await assert.rejects(scanRecruiterList(adapter), { code: 'PAGE_CHANGED' });
    assert.equal(adapter.scrolls.length, 1);
    assert.notEqual(adapter.scrolls[0], 0);
  });
}

test('recycled row ID that changes person is rejected', async () => {
  await assert.rejects(scanRecruiterList(mockAdapter([
    frame([row('a', 'First')]), frame([row('a', 'Second')], 100),
  ])), { code: 'ROW_ID_CONFLICT' });
});

test('updated preview for the same identity is retained without duplicating the contact', async () => {
  const result = await scanRecruiterList(mockAdapter([
    frame([row('a')]), frame([{ ...row('a'), lastMessagePreview: 'New preview' }], 100),
  ]), { maxSteps: 2 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lastMessagePreview, 'New preview');
  assert.equal(result.rows[0].sourceIndex, 1);
});

test('a context change during the final check prevents storing a stale scan', async () => {
  const adapter = mockAdapter([frame([row('a')])], {
    onRead: (value, count) => count === 2 ? { ...value, selectedRow: 'changed' } : value,
  });
  await assert.rejects(scanRecruiterList(adapter, { maxSteps: 1 }), { code: 'PAGE_CHANGED' });
  assert.equal(adapter.scrolls.length, 0);
});

test('a row without a usable DOM identity fails instead of silently losing the contact', async () => {
  await assert.rejects(scanRecruiterList(mockAdapter([
    frame([row('a'), row(null, 'Missing identity')]),
  ])), { code: 'ROW_ID_UNAVAILABLE' });
});

test('late list changes during the final read invalidate stale completeness', async () => {
  const adapter = mockAdapter([frame([row('a')])], {
    onRead: (value, count) => count === 2 ? { ...value, rows: [...value.rows, row('late')] } : value,
  });
  await assert.rejects(scanRecruiterList(adapter, { maxSteps: 1 }), { code: 'LIST_CHANGED' });
  assert.equal(adapter.scrolls.length, 0);
});

test('invalid limits are rejected before touching the page', async () => {
  const adapter = { read: async () => assert.fail('Must not read browser') };
  for (const options of [{ maxSteps: 0 }, { maxSteps: 501 }, { maxRows: 0 }, { maxRows: 1.5 }]) {
    await assert.rejects(scanRecruiterList(adapter, options), { code: 'INVALID_LIMIT' });
  }
});

test('adapter rejects blocked page results and malformed evaluation', async () => {
  const blocked = createListAdapter({ send: async () => ({ result: { value: { blocked: 'ACCOUNT_UNVERIFIED' } } }) });
  await assert.rejects(blocked.read(), { code: 'ACCOUNT_UNVERIFIED' });
  const failed = createListAdapter({ send: async () => ({ exceptionDetails: { text: 'Missing DOM' } }) });
  await assert.rejects(failed.read(), { code: 'PAGE_READ_FAILED' });
});

test('invalid scroll never reaches the browser', async () => {
  const adapter = createListAdapter({ send: async () => assert.fail('Must not touch browser') });
  for (const top of [-1, NaN, Infinity]) await assert.rejects(adapter.scroll(top, ''), { code: 'INVALID_SCROLL' });
});
