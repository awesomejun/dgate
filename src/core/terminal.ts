import { CellBuffer } from './buffer.ts';

export type KeyEvent =
  | { kind: 'ctrl-c' }
  | { kind: 'escape' }
  | { kind: 'enter' }
  | { kind: 'tab'; shift: boolean }
  | { kind: 'backspace' }
  | { kind: 'arrow'; dir: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'page'; dir: 'up' | 'down' }
  | { kind: 'char'; value: string };

/**
 * Raw 터미널 바이트 버퍼를 구조화된 키 이벤트 배열로 파싱합니다. (UTF-8 한글 입력 완벽 지원)
 */
export function parseKeyEvents(chunk: Buffer | string): KeyEvent[] {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  const events: KeyEvent[] = [];
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;
    const code = ch.charCodeAt(0);

    if (code === 0x03) {
      events.push({ kind: 'ctrl-c' });
      i++;
      continue;
    }

    if (code === 0x0d || code === 0x0a) {
      events.push({ kind: 'enter' });
      i++;
      continue;
    }

    if (code === 0x09) {
      events.push({ kind: 'tab', shift: false });
      i++;
      continue;
    }

    if (code === 0x7f || code === 0x08) {
      events.push({ kind: 'backspace' });
      i++;
      continue;
    }

    if (code === 0x1b) {
      const rest = str.slice(i);
      if (rest.startsWith('\x1b[Z')) {
        events.push({ kind: 'tab', shift: true });
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) {
        events.push({ kind: 'arrow', dir: 'up' });
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) {
        events.push({ kind: 'arrow', dir: 'down' });
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[C') || rest.startsWith('\x1bOC')) {
        events.push({ kind: 'arrow', dir: 'right' });
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[D') || rest.startsWith('\x1bOD')) {
        events.push({ kind: 'arrow', dir: 'left' });
        i += 3;
        continue;
      }
      if (rest.startsWith('\x1b[5~')) {
        events.push({ kind: 'page', dir: 'up' });
        i += 4;
        continue;
      }
      if (rest.startsWith('\x1b[6~')) {
        events.push({ kind: 'page', dir: 'down' });
        i += 4;
        continue;
      }
      // 기타 CSI 시퀀스 건너뛰기
      const csiMatch = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(rest);
      if (csiMatch) {
        i += csiMatch[0].length;
        continue;
      }
      events.push({ kind: 'escape' });
      i++;
      continue;
    }

    if (code < 0x20) {
      i++;
      continue;
    }

    // 일반 유니코드 코드포인트(한글, 영문, 기호 등) 추출
    const cp = str.codePointAt(i)!;
    const symbol = String.fromCodePoint(cp);
    events.push({ kind: 'char', value: symbol });
    i += symbol.length;
  }

  return events;
}

export class TerminalScreen {
  private prevBuffer: CellBuffer | null = null;
  private active = false;
  private cleanupHandlersRegistered = false;

  getSize(): { cols: number; rows: number } {
    return {
      cols: process.stdout.columns || 140,
      rows: process.stdout.rows || 42,
    };
  }

  enter(enableKeyboard = true): void {
    if (this.active) return;
    this.active = true;

    // Alternate Screen 진입 + 커서 숨김 + 화면 초기화
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');

    if (enableKeyboard && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }

    if (!this.cleanupHandlersRegistered) {
      this.cleanupHandlersRegistered = true;
      const restore = () => this.leave();
      process.on('exit', restore);
      process.on('SIGINT', () => {
        this.leave();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        this.leave();
        process.exit(0);
      });
    }
  }

  invalidate(): void {
    this.prevBuffer = null;
    if (this.active) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
  }

  present(nextBuffer: CellBuffer): void {
    if (!this.active) return;
    const diff = nextBuffer.toAnsiDiff(this.prevBuffer, true);
    if (diff.length > 0) {
      process.stdout.write(diff);
    }
    this.prevBuffer = nextBuffer;
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      // 무시
    }
    // 스타일 리셋 + 커서 복원 + Alternate Screen 복귀
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
}
