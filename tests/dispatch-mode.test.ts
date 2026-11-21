/**
 * strict dispatch 집행 장치 단위 검증 — 모드 파일 라운드트립·검증·표식 판정.
 *
 * 실행: `node --test tests/dispatch-mode.test.ts`
 * 주의: 모드 파일은 임시 경로 주입 변형(_at)만 쓴다 — 전역 상태 파일 무변경.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  forkHasDispatchProvenance,
  readDispatchModeAt,
  writeDispatchModeAt,
} from '../src/decision/engine.ts';

test('모드 파일 라운드트립 — 부재=빈값(off 취급), 대소문자 정규화', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-dm-'));
  const p = path.join(dir, 'dispatch-mode');
  assert.equal(readDispatchModeAt(p), '');
  writeDispatchModeAt(p, 'strict');
  assert.equal(readDispatchModeAt(p), 'strict');
  writeDispatchModeAt(p, 'OFF');
  assert.equal(readDispatchModeAt(p), 'off');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('잘못된 모드 값은 거부(파일 무변경)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-dm-2-'));
  const p = path.join(dir, 'dispatch-mode');
  assert.throws(() => writeDispatchModeAt(p, 'bogus'));
  assert.equal(readDispatchModeAt(p), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('표식 판정 — dispatch:true 스탬프가 있는 fork만 통과', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE forks (fork_id TEXT PRIMARY KEY, metadata_json TEXT)');
  db.prepare("INSERT INTO forks VALUES ('fk_a', ?)").run('{"dispatch":true}');
  db.prepare("INSERT INTO forks VALUES ('fk_b', ?)").run('{"title":"x"}');
  db.prepare('INSERT INTO forks VALUES (\'fk_c\', NULL)').run();
  assert.equal(forkHasDispatchProvenance(db, 'fk_a'), true);
  assert.equal(forkHasDispatchProvenance(db, 'fk_b'), false);
  assert.equal(forkHasDispatchProvenance(db, 'fk_c'), false);
  assert.equal(forkHasDispatchProvenance(db, 'fk_missing'), false);
});
