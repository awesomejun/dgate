/**
 * `tests/contracts-block.test.ts` — `installContractsBlock` 계약 블록 멱등 설치 테스트.
 *
 * 목적: 대상 레포 AGENTS.md에 dgate 계약 블록이
 * ① 최초 설치(파일 없음 → 블록만 생성 / 마커 없는 기존 파일 → 끝에 추가),
 * ② 재실행 changed=false(쓰기 없음),
 * ③ 서로 다른 마커 버전 블록 → 소스 블록으로 교체(주변 문서 보존)됨을 검증한다.
 *
 * 실행: `node --test tests/contracts-block.test.ts` (외부 의존성 0개)
 *
 * 주의: 대상 AGENTS.md는 임시 mkdtemp 디렉터리에만 만들고, 블록 소스는 실제
 * 저장소 `skills/dgate/AGENTS-BLOCK.md`(기본 orchestratorRoot)를 읽기만 한다 —
 * 실제 저장소에 어떤 쓰기도 하지 않는다.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installContractsBlock } from '../scripts/setup.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 테스트용 임시 디렉터리 — 대상 레포를 시뮬레이션한다. */
function makeTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `contracts-${process.pid}-`));
}

/** 실제 소스 블록(끝 개행 정규화) — 설치 결과의 기댓값. */
function sourceBlock(): string {
  return fs
    .readFileSync(path.join(REPO_ROOT, 'skills', 'dgate', 'AGENTS-BLOCK.md'), 'utf8')
    .replace(/\n+$/, '');
}

// ---------- (a) 최초 설치 ----------

test('contracts-block (a) — 최초 설치: 파일 없으면 블록만 생성, 마커 없는 기존 파일엔 끝에 추가', () => {
  const block = sourceBlock();
  const repo = makeTemp();
  const repo2 = makeTemp();
  try {
    // 파일 없음 — 블록만 넣어 생성
    const r1 = installContractsBlock({ repoDir: repo });
    assert.equal(r1.changed, true, '최초 설치는 changed=true');
    assert.equal(r1.reason, 'created');
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), `${block}\n`);

    // 기존 파일에 마커 없음 — 빈 줄 하나 두고 끝에 추가(기존 내용 보존)
    fs.writeFileSync(path.join(repo2, 'AGENTS.md'), '# 프로젝트 가이드\n\n본문.\n');
    const r2 = installContractsBlock({ repoDir: repo2 });
    assert.equal(r2.changed, true);
    assert.equal(r2.reason, 'appended');
    assert.equal(
      fs.readFileSync(path.join(repo2, 'AGENTS.md'), 'utf8'),
      `# 프로젝트 가이드\n\n본문.\n\n${block}`,
      '기존 내용 뒤 빈 줄 하나 + 블록',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repo2, { recursive: true, force: true });
  }
});

// ---------- (b) 재실행 멱등 ----------

test('contracts-block (b) — 재실행 changed=false, 내용 불변', () => {
  const repo = makeTemp();
  try {
    const r1 = installContractsBlock({ repoDir: repo });
    assert.equal(r1.changed, true);
    const after1 = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');

    const r2 = installContractsBlock({ repoDir: repo });
    assert.equal(r2.changed, false, '동일 내용이면 changed=false');
    assert.equal(r2.reason, 'already-current');
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), after1, '재실행은 쓰기 없음');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------- (c) 다른 버전 블록 교체 ----------

test('contracts-block (c) — 다른 마커 버전 블록이면 소스 블록으로 교체(주변 문서 보존)', () => {
  const block = sourceBlock();
  const repo = makeTemp();
  try {
    // 옛 버전 마커 블록을 심어둔 AGENTS.md
    fs.writeFileSync(
      path.join(repo, 'AGENTS.md'),
      [
        '# 프로젝트 가이드',
        '',
        '위쪽 본문.',
        '',
        '<!-- dgate:begin v=2026-11-01 — 옛 버전 관리 블록 -->',
        '옛 계약 내용 — 바뀌어야 함',
        '<!-- dgate:end -->',
        '',
        '아래쪽 본문.',
        '',
      ].join('\n'),
    );
    const r = installContractsBlock({ repoDir: repo });
    assert.equal(r.changed, true);
    assert.equal(r.reason, 'updated');
    const content = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.ok(!content.includes('옛 계약 내용'), '옛 블록 본문은 제거');
    assert.ok(!content.includes('v=2026-11-01'), '옛 마커는 제거');
    assert.ok(content.includes('<!-- dgate:begin'), '새 블록 마커 존재');
    assert.equal(
      content,
      `# 프로젝트 가이드\n\n위쪽 본문.\n\n${block}\n\n아래쪽 본문.\n`,
      '관리 블록만 교체되고 주변 문서는 그대로',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
