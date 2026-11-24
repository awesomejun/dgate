/**
 * sublead Phase 2a — fork 소유 스코핑(`HERDR_CONVERSATION`) + 손자 attribution env 전파 검증.
 *
 * 실행: `node --test tests/fork-ownership.test.ts`
 * 범위:
 * - `conversationFromEnv`: 값 있음·빈 문자열·undefined 분기
 * - `forkContextEnv`: 정상(fork+conv)·fork만·`fk_fallback_` 접두·null 분기
 * - `issueFork` → `getFork`: 임시 DB에서 `conversation_id` 1급 컬럼 회독 일치
 * - `buildSanitizedChildEnv` + `extraEnv: forkContextEnv(...)`: 시크릿 제거 + 전파 키 생존
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { conversationFromEnv } from '../scripts/dispatch.ts';
import { openDbSafe } from '../src/decision/db.ts';
import { forkContextEnv } from '../src/decision/dg.ts';
import { getFork, issueFork } from '../src/decision/engine.ts';
import { buildSanitizedChildEnv } from '../src/decision/redact.ts';

test('conversationFromEnv: 비어 있지 않은 HERDR_CONVERSATION 반환, 빈 문자열·미설정은 null', () => {
  assert.equal(conversationFromEnv({ HERDR_CONVERSATION: 'conv-sublead-42' }), 'conv-sublead-42');
  assert.equal(conversationFromEnv({ HERDR_CONVERSATION: '' }), null);
  assert.equal(conversationFromEnv({ HERDR_CONVERSATION: undefined }), null);
  assert.equal(conversationFromEnv({}), null);
});

test('forkContextEnv: 정상(fork+conv), fork만, fallback 접두, null 분기', () => {
  assert.deepEqual(forkContextEnv('fk_1234567890ab', 'conv-sub-1'), {
    HERDR_FORK_ID: 'fk_1234567890ab',
    HERDR_CONVERSATION: 'conv-sub-1',
  });
  assert.deepEqual(forkContextEnv('fk_1234567890ab', null), {
    HERDR_FORK_ID: 'fk_1234567890ab',
  });
  assert.deepEqual(forkContextEnv('fk_1234567890ab', ''), {
    HERDR_FORK_ID: 'fk_1234567890ab',
  });
  assert.deepEqual(forkContextEnv('fk_fallback_deadbeef', 'conv-sub-1'), {});
  assert.deepEqual(forkContextEnv(null, 'conv-sub-1'), {});
  assert.deepEqual(forkContextEnv(null, null), {});
});

test('issueFork → getFork: conversationId 전달 시 임시 DB 회독 일치 및 미전달 시 null 유지', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `dg-fork-own-${process.pid}-`));
  const dbPath = path.join(tmpDir, 'decision.db');
  const db = openDbSafe(dbPath, { busyTimeoutMs: 5000 });
  assert.ok(db, '임시 DB 오픈 성공');
  try {
    const ownedFork = issueFork(db, {
      projectId: 'proj-ut',
      projectLabel: 'ut',
      route: 'file_select',
      toolClass: 'file_edit',
      decision: 'split',
      pAtGate: 0.5,
      basisAtGate: 'prior',
      forcedSplit: false,
      conversationId: 'conv-sublead-owner',
    });
    const ownedRow = getFork(db, ownedFork);
    assert.ok(ownedRow, '발급된 소유 fork 조회 성공');
    assert.equal(ownedRow.conversation_id, 'conv-sublead-owner');

    const rootFork = issueFork(db, {
      projectId: 'proj-ut',
      projectLabel: 'ut',
      route: 'file_select',
      toolClass: 'file_edit',
      decision: 'split',
      pAtGate: 0.5,
      basisAtGate: 'prior',
      forcedSplit: false,
      conversationId: null,
    });
    const rootRow = getFork(db, rootFork);
    assert.ok(rootRow, 'conversation_id 미지정 fork 조회 성공');
    assert.equal(rootRow.conversation_id, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildSanitizedChildEnv: forkContextEnv extraEnv 주입 키 생존 및 민감 키 차단 유지', () => {
  const forkCtx = forkContextEnv('fk_abcdef012345', 'conv-sub-99');
  const childEnv = buildSanitizedChildEnv({
    baseEnv: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret-value-12345678',
      HERDR_ROLE: 'sublead',
    },
    extraEnv: forkCtx,
  });
  assert.equal(childEnv.HERDR_FORK_ID, 'fk_abcdef012345');
  assert.equal(childEnv.HERDR_CONVERSATION, 'conv-sub-99');
  assert.equal(childEnv.HERDR_ROLE, 'sublead');
  assert.equal(childEnv.PATH, '/usr/bin');
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
});
