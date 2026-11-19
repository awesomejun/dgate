import { THEME, lerpColor, sameColor, type RGB } from '../theme.ts';
import { codePointWidth, isAmbiguousSymbol, stringWidth, truncateWidth } from './width.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Cell {
  ch: string;
  fg: RGB;
  bg: RGB;
  bold: boolean;
  cont: boolean; // 전각 문자(폭 2)의 두 번째 셀 표시
}

export interface TextSegment {
  text: string;
  fg: RGB;
  bg?: RGB;
  bold?: boolean;
}

export type BoxStyle = 'single' | 'heavy' | 'double';

const BOX_CHARS: Record<
  BoxStyle,
  { tl: string; tr: string; bl: string; br: string; h: string; v: string }
> = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  heavy: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
};

const EIGHTH_BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;

export class CellBuffer {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];

  constructor(width: number, height: number, defaultBg: RGB = THEME.bg, defaultFg: RGB = THEME.fg) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const total = this.width * this.height;
    this.cells = new Array<Cell>(total);
    for (let i = 0; i < total; i++) {
      this.cells[i] = {
        ch: ' ',
        fg: defaultFg,
        bg: defaultBg,
        bold: false,
        cont: false,
      };
    }
  }

  private idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  getCell(x: number, y: number): Cell | undefined {
    if (!this.inBounds(x, y)) return undefined;
    return this.cells[this.idx(x, y)];
  }

  /**
   * 전각(폭 2) 문자 경계 깨짐을 자동으로 보정하며 셀에 문자를 기록합니다.
   */
  setChar(x: number, y: number, ch: string, fg: RGB, bg?: RGB, bold = false): number {
    if (!this.inBounds(x, y)) return 0;
    const cp = ch.codePointAt(0) ?? 0x20;
    const cw = codePointWidth(cp);
    if (cw <= 0) return 0;

    const i = this.idx(x, y);
    const cur = this.cells[i]!;
    const resolvedBg = bg ?? cur.bg;

    // 덮어쓰려는 셀이 이전 전각 문자의 우측 절반(cont)이면 좌측 절반을 공백으로 정리
    if (cur.cont && x > 0) {
      const left = this.cells[this.idx(x - 1, y)]!;
      left.ch = ' ';
      left.cont = false;
    }

    if (cw === 2) {
      // 우측 끝 셀에는 폭 2 문자를 놓을 수 없으므로 공백 처리
      if (x + 1 >= this.width) {
        cur.ch = ' ';
        cur.fg = fg;
        cur.bg = resolvedBg;
        cur.bold = false;
        cur.cont = false;
        return 1;
      }

      const right = this.cells[this.idx(x + 1, y)]!;
      // 만약 x+1에 또 다른 전각 문자의 시작점이 있었다면 x+2의 cont를 해제
      if (!right.cont && codePointWidth(right.ch.codePointAt(0) ?? 0x20) === 2 && x + 2 < this.width) {
        const right2 = this.cells[this.idx(x + 2, y)]!;
        right2.ch = ' ';
        right2.cont = false;
      }

      cur.ch = ch;
      cur.fg = fg;
      cur.bg = resolvedBg;
      cur.bold = bold;
      cur.cont = false;

      right.ch = '';
      right.fg = fg;
      right.bg = resolvedBg;
      right.bold = bold;
      right.cont = true;
      return 2;
    }

    // cw === 1 인 경우: 기존에 이 자리가 전각 문자 시작점이었다면 x+1의 cont를 공백으로 복구
    if (!cur.cont && codePointWidth(cur.ch.codePointAt(0) ?? 0x20) === 2 && x + 1 < this.width) {
      const right = this.cells[this.idx(x + 1, y)]!;
      right.ch = ' ';
      right.cont = false;
    }

    cur.ch = ch;
    cur.fg = fg;
    cur.bg = resolvedBg;
    cur.bold = bold;
    cur.cont = false;
    return 1;
  }

  fillRect(rect: Rect, bg: RGB, fg: RGB = THEME.fg, ch = ' '): void {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.w);
    const y1 = Math.min(this.height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.setChar(x, y, ch, fg, bg, false);
      }
    }
  }

  writeText(
    x: number,
    y: number,
    text: string,
    fg: RGB,
    bg?: RGB,
    bold = false,
    maxWidth?: number
  ): number {
    if (y < 0 || y >= this.height) return 0;
    const clipped = maxWidth !== undefined ? truncateWidth(text, maxWidth, '…') : text;
    let cx = x;
    for (const ch of clipped) {
      const cw = codePointWidth(ch.codePointAt(0) ?? 0x20);
      if (cw <= 0) continue;
      if (cx >= this.width) break;
      if (maxWidth !== undefined && cx - x + cw > maxWidth) break;
      if (cx >= 0) {
        this.setChar(cx, y, ch, fg, bg, bold);
      }
      cx += cw;
    }
    return cx - x;
  }

  writeCentered(
    x: number,
    y: number,
    width: number,
    text: string,
    fg: RGB,
    bg?: RGB,
    bold = false
  ): void {
    if (width <= 0) return;
    const clipped = truncateWidth(text, width, '…');
    const tw = stringWidth(clipped);
    const startX = x + Math.max(0, Math.floor((width - tw) / 2));
    this.writeText(startX, y, clipped, fg, bg, bold, width);
  }

  writeRight(
    x: number,
    y: number,
    width: number,
    text: string,
    fg: RGB,
    bg?: RGB,
    bold = false
  ): void {
    if (width <= 0) return;
    const clipped = truncateWidth(text, width, '…');
    const tw = stringWidth(clipped);
    const startX = x + Math.max(0, width - tw);
    this.writeText(startX, y, clipped, fg, bg, bold, width);
  }

  writeSegments(x: number, y: number, segments: readonly TextSegment[], maxWidth?: number): number {
    let cx = x;
    for (const seg of segments) {
      const remain = maxWidth !== undefined ? maxWidth - (cx - x) : undefined;
      if (remain !== undefined && remain <= 0) break;
      cx += this.writeText(cx, y, seg.text, seg.fg, seg.bg, seg.bold ?? false, remain);
    }
    return cx - x;
  }

  writeSegmentsCentered(x: number, y: number, width: number, segments: readonly TextSegment[]): void {
    const totalW = segments.reduce((acc, s) => acc + stringWidth(s.text), 0);
    const startX = x + Math.max(0, Math.floor((width - totalW) / 2));
    this.writeSegments(startX, y, segments, width);
  }

  drawHLine(x: number, y: number, len: number, ch: string, fg: RGB, bg?: RGB, bold = false): void {
    for (let i = 0; i < len; i++) {
      this.setChar(x + i, y, ch, fg, bg, bold);
    }
  }

  drawVLine(x: number, y: number, len: number, ch: string, fg: RGB, bg?: RGB, bold = false): void {
    for (let i = 0; i < len; i++) {
      this.setChar(x, y + i, ch, fg, bg, bold);
    }
  }

  drawBox(
    rect: Rect,
    opts: {
      style?: BoxStyle;
      borderColor: RGB;
      fillBg?: RGB;
      title?: string;
      titleColor?: RGB;
      rightLabel?: string;
      rightLabelColor?: RGB;
      boldBorder?: boolean;
    }
  ): void {
    if (rect.w < 2 || rect.h < 2) return;
    const chars = BOX_CHARS[opts.style ?? 'single'];
    const bg = opts.fillBg ?? THEME.bg;
    if (opts.fillBg) {
      this.fillRect(rect, opts.fillBg);
    }

    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.w - 1;
    const y1 = rect.y + rect.h - 1;
    const b = opts.boldBorder ?? false;

    this.setChar(x0, y0, chars.tl, opts.borderColor, bg, b);
    this.setChar(x1, y0, chars.tr, opts.borderColor, bg, b);
    this.setChar(x0, y1, chars.bl, opts.borderColor, bg, b);
    this.setChar(x1, y1, chars.br, opts.borderColor, bg, b);

    for (let x = x0 + 1; x < x1; x++) {
      this.setChar(x, y0, chars.h, opts.borderColor, bg, b);
      this.setChar(x, y1, chars.h, opts.borderColor, bg, b);
    }
    for (let y = y0 + 1; y < y1; y++) {
      this.setChar(x0, y, chars.v, opts.borderColor, bg, b);
      this.setChar(x1, y, chars.v, opts.borderColor, bg, b);
    }

    if (opts.title && rect.w > 6) {
      const label = ` ${opts.title} `;
      this.writeText(x0 + 2, y0, label, opts.titleColor ?? THEME.muted, bg, false, rect.w - 4);
    }

    if (opts.rightLabel && rect.w > 10) {
      const rLabel = ` ${opts.rightLabel} `;
      const rw = stringWidth(rLabel);
      const rx = x1 - 1 - rw;
      if (rx > x0 + 2) {
        this.writeText(rx, y0, rLabel, opts.rightLabelColor ?? THEME.muted, bg, false, rw);
      }
    }
  }

  /**
   * 1/8 서브블록과 미세 스트라이프 명암으로 HTML의 프로그레스 바 질감을 재현합니다.
   */
  drawProgressBar(
    x: number,
    y: number,
    width: number,
    ratio: number,
    fillFg: RGB,
    trackBg: RGB
  ): void {
    if (width <= 0) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    const totalEighths = Math.round(clamped * width * 8);
    const fullCells = Math.floor(totalEighths / 8);
    const remEighths = totalEighths % 8;

    const stripeFill = lerpColor(fillFg, THEME.bg, 0.14);
    const stripeTrack = lerpColor(trackBg, THEME.bg, 0.25);

    for (let i = 0; i < width; i++) {
      const isStripe = i % 5 === 4;
      const cellTrack = isStripe ? stripeTrack : trackBg;
      const cellFill = isStripe ? stripeFill : fillFg;

      if (i < fullCells) {
        this.setChar(x + i, y, '█', cellFill, cellTrack, false);
      } else if (i === fullCells && remEighths > 0) {
        this.setChar(x + i, y, EIGHTH_BLOCKS[remEighths]!, cellFill, cellTrack, false);
      } else {
        this.setChar(x + i, y, '░', lerpColor(cellTrack, THEME.muted, 0.18), cellTrack, false);
      }
    }
  }

  /**
   * 경로 좌표 배열 위에 데이터 흐름 펄스(헤드 + 트레일 글로우)를 렌더링합니다.
   */
  drawPulseAlongPath(
    path: ReadonlyArray< readonly [number, number] >,
    progress01: number,
    color: RGB,
    headGlyph = '●'
  ): void {
    if (path.length === 0) return;
    const p = ((progress01 % 1) + 1) % 1;
    const headIdx = Math.floor(p * path.length);

    // 짧은 잔상(trail) 2칸 표현
    for (let offset = 2; offset >= 0; offset--) {
      const idx = headIdx - offset;
      if (idx < 0 || idx >= path.length) continue;
      const [px, py] = path[idx]!;
      const existing = this.getCell(px, py);
      if (!existing) continue;
      if (offset === 0) {
        this.setChar(px, py, headGlyph, color, existing.bg, true);
      } else {
        const faded = lerpColor(color, existing.fg, offset * 0.38);
        this.setChar(px, py, existing.ch, faded, existing.bg, false);
      }
    }
  }

  /**
   * 테스트 및 스냅샷 검증용 플레인 텍스트 변환
   */
  toPlainString(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = '';
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[this.idx(x, y)]!;
        if (!c.cont) {
          row += c.ch;
        }
      }
      lines.push(row.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  /**
   * 단일 프레임 전체 ANSI 문자열 출력 (--ansi-snapshot 지원용)
   */
  toAnsiFullFrame(): string {
    return this.toAnsiDiff(null, false);
  }

  /**
   * 이전 프레임과 비교해 변경된 셀만 최소 이스케이프 시퀀스로 직렬화합니다.
   * Synchronized Output (\x1b[?2026h/l)으로 깜빡임을 완전히 제거합니다.
   */
  toAnsiDiff(prev: CellBuffer | null, cursorSync = true): string {
    const canDiff =
      prev !== null && prev.width === this.width && prev.height === this.height;

    let out = cursorSync ? '\x1b[?2026h' : '';
    let curFg: RGB | null = null;
    let curBg: RGB | null = null;
    let curBold: boolean | null = null;
    let cursorX = -1;
    let cursorY = -1;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = this.idx(x, y);
        const cell = this.cells[i]!;
        if (cell.cont) continue;

        const cw = codePointWidth(cell.ch.codePointAt(0) ?? 0x20);
        if (canDiff) {
          const pCell = prev.cells[i]!;
          const sameMain =
            pCell.ch === cell.ch &&
            pCell.bold === cell.bold &&
            pCell.cont === cell.cont &&
            sameColor(pCell.fg, cell.fg) &&
            sameColor(pCell.bg, cell.bg);

          let sameNext = true;
          if (cw === 2 && x + 1 < this.width) {
            const nCell = this.cells[i + 1]!;
            const pnCell = prev.cells[i + 1]!;
            sameNext =
              pnCell.cont === nCell.cont && sameColor(pnCell.bg, nCell.bg);
          }
          if (sameMain && sameNext) {
            continue;
          }
        }

        if (cursorY !== y || cursorX !== x) {
          out += `\x1b[${y + 1};${x + 1}H`;
          cursorY = y;
          cursorX = x;
        }

        if (curBold !== cell.bold) {
          out += cell.bold ? '\x1b[1m' : '\x1b[22m';
          curBold = cell.bold;
        }
        if (!curFg || !sameColor(curFg, cell.fg)) {
          out += `\x1b[38;2;${cell.fg.r};${cell.fg.g};${cell.fg.b}m`;
          curFg = cell.fg;
        }
        if (!curBg || !sameColor(curBg, cell.bg)) {
          out += `\x1b[48;2;${cell.bg.r};${cell.bg.g};${cell.bg.b}m`;
          curBg = cell.bg;
        }

        out += cell.ch;
        const cp = cell.ch.codePointAt(0) ?? 0x20;
        if (cursorSync && isAmbiguousSymbol(cp)) {
          // 터미널의 East Asian Ambiguous Width 설정과 무관하게 다음 셀에서 좌표를 재동기화
          cursorX = -1;
        } else {
          cursorX += cw;
        }
      }
      if (!cursorSync && y < this.height - 1) {
        out += '\x1b[0m\n';
        curFg = null;
        curBg = null;
        curBold = null;
        cursorX = 0;
        cursorY = y + 1;
      }
    }

    out += cursorSync ? '\x1b[0m\x1b[?2026l' : '\x1b[0m';
    return out;
  }
}
