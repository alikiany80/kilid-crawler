const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir } = require('./helpers');
const { StateStore, contentHash } = require('../src/state');

test('StateStore tracks known listings and never downgrades full details', t => {
  const file = path.join(tempDir(t), 's.sqlite');
  const state = new StateStore(file);
  assert.equal(state.isKnown('1'), false);
  assert.equal(state.needsDetails('1'), true);

  state.markSeen([{ sourceId: '1', hasFullDetails: true, crawledAt: 'a' }]);
  state.markSeen([{ sourceId: '1', hasFullDetails: false, crawledAt: 'b' }]);
  assert.equal(state.isKnown('1'), true);
  assert.equal(state.needsDetails('1'), false);
  state.close();

  const reopened = new StateStore(file);
  assert.equal(reopened.get('1').hasFullDetails, true, 'persisted across runs');
  const pragmas = ['journal_mode', 'busy_timeout', 'temp_store'].map(p => Object.values(reopened.db.prepare(`PRAGMA ${p}`).get())[0]);
  assert.deepEqual(pragmas, ['wal', 5000, 2]);
  reopened.close();
});

test('contentHash ignores crawledAt', () => {
  assert.equal(contentHash({ a: 1, crawledAt: 'x' }), contentHash({ a: 1, crawledAt: 'y' }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});
