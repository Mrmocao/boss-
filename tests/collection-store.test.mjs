import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveCollection } from '../src/collection-store.mjs';

const sample = () => ({ account: { displayName: '测试招聘员', identityConfidence: 'display_only' },
  rows: [{ name: '测试甲', jobTitle: 'Unity', lastMessagePreview: '您好', displayTime: '昨天',
    unreadCount: 1, platformCandidateId: null, sourceIndex: 0 }],
  scope: { completeness: 'partial', loadedRows: 1 }, collectedAt: '2026-11-02T04:00:00Z',
  sourceUrl: 'https://www.zhipin.com/web/chat/index?private=removed' });

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'boss-collection-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('identical content reuses archive while updating latest observation time', async t => {
  const rootDir = await directory(t), snapshot = sample();
  const first = await saveCollection({ rootDir, profile: 'company', snapshot });
  const second = await saveCollection({ rootDir, profile: 'company', snapshot: { ...snapshot, collectedAt: '2026-11-02T04:05:00Z' } });
  assert.equal(first.archiveReused, false);
  assert.equal(second.archiveReused, true);
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal((await readdir(join(first.paths.directory, 'snapshots'))).length, 1);
  assert.equal(JSON.parse(await readFile(first.paths.archive, 'utf8')).collectedAt, snapshot.collectedAt);
  const latest = JSON.parse(await readFile(second.paths.latest, 'utf8'));
  assert.equal(latest.collectedAt, '2026-11-02T04:05:00Z');
  assert.equal(latest.sourceUrl, 'https://www.zhipin.com/web/chat/index');
});

test('same names on different jobs are retained and changed snapshots are archived', async t => {
  const rootDir = await directory(t), snapshot = sample();
  await saveCollection({ rootDir, profile: 'company', snapshot });
  snapshot.rows.push({ ...snapshot.rows[0], jobTitle: '测试', sourceIndex: 1 });
  const result = await saveCollection({ rootDir, profile: 'company', snapshot });
  assert.equal(result.stats.rowCount, 2);
  assert.equal(result.stats.uniquePersonCount, null);
  assert.equal(result.stats.confirmedApplicantCount, null);
  assert.equal((await readdir(join(result.paths.directory, 'snapshots'))).length, 2);
  const latest = JSON.parse(await readFile(result.paths.latest, 'utf8'));
  assert.equal(latest.rows.length, 2);
  assert.equal(latest.rows[0].name, latest.rows[1].name);
});

test('CSV neutralizes formulas and preserves the original text in JSON', async t => {
  const rootDir = await directory(t), snapshot = sample();
  snapshot.rows[0].name = '=1+1';
  snapshot.rows[0].jobTitle = '  +SUM(1,2)';
  snapshot.rows[0].lastMessagePreview = '\t@danger\n"quoted"';
  const result = await saveCollection({ rootDir, profile: 'company', snapshot });
  const csv = await readFile(result.paths.csv, 'utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'  +SUM(1,2)"'));
  assert.ok(csv.includes('"\'\t@danger\n""quoted"""'));
  const json = JSON.parse(await readFile(result.paths.latest, 'utf8'));
  assert.equal(json.rows[0].name, '=1+1');
  assert.equal(json.rows[0].lastMessagePreview, snapshot.rows[0].lastMessagePreview);
});

test('profiles and distinct display names have separate namespaces with explicit weak identity', async t => {
  const rootDir = await directory(t), snapshot = sample();
  const company = await saveCollection({ rootDir, profile: 'company', snapshot });
  const personal = await saveCollection({ rootDir, profile: 'personal', snapshot });
  const other = await saveCollection({ rootDir, profile: 'company', snapshot: { ...snapshot, account: { displayName: '另一个测试招聘员' } } });
  assert.notEqual(company.paths.directory, personal.paths.directory);
  assert.notEqual(company.paths.directory, other.paths.directory);
  assert.equal(company.accountContext.identityConfidence, 'display_only');
  assert.equal(company.accountContext.stableAccountId, null);
  assert.match(company.accountContext.warning, /同名账号/);
});

test('invalid profiles, account identity and origins do not produce a collection', async t => {
  const rootDir = await directory(t);
  await assert.rejects(saveCollection({ rootDir, profile: '../company', snapshot: sample() }), { code: 'INVALID_COLLECTION' });
  await assert.rejects(saveCollection({ rootDir, profile: 'company', snapshot: { ...sample(), account: { displayName: '' } } }), { code: 'INVALID_COLLECTION' });
  await assert.rejects(saveCollection({ rootDir, profile: 'company', snapshot: { ...sample(), sourceUrl: 'https://www.zhipin.com.example.org/' } }), { code: 'INVALID_COLLECTION' });
  assert.deepEqual(await readdir(rootDir), []);
});

test('same display name in two company profiles cannot share or overwrite snapshots', async t => {
  const rootDir = await directory(t), firstSnapshot = sample();
  const first = await saveCollection({ rootDir, profile:'company', snapshot:firstSnapshot });
  const secondSnapshot = { ...sample(), rows:[{ ...sample().rows[0], name:'第二账号候选人' }] };
  const second = await saveCollection({ rootDir, profile:'company-2', snapshot:secondSnapshot });
  assert.notEqual(first.paths.directory, second.paths.directory);
  assert.notEqual(first.accountContext.namespace, second.accountContext.namespace);
  assert.equal(second.accountContext.profile, 'company-2');
  assert.equal(JSON.parse(await readFile(first.paths.latest, 'utf8')).rows[0].name, '测试甲');
  assert.equal(JSON.parse(await readFile(second.paths.latest, 'utf8')).rows[0].name, '第二账号候选人');
  const repeated = await saveCollection({ rootDir, profile:'company-2', snapshot:secondSnapshot });
  assert.equal(repeated.archiveReused, true);
  assert.equal((await readdir(join(first.paths.directory, 'snapshots'))).length, 1);
  assert.equal((await readdir(join(second.paths.directory, 'snapshots'))).length, 1);
});
