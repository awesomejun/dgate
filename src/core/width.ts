/**
 * 터미널 셀 폭(East Asian Width) 정밀 계산 유틸리티
 * 한글 가~힣, 자모, CJK 한자, 전각 기호는 2셀, 박스 드로잉/ASCII/기하 기호는 1셀로 계산합니다.
 */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // 결합 문자 (Combining marks)
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }

  // 한글 초성/중성/종성, 호환 자모, 가~힣, CJK 기호/한자, 전각 형태, 이모지 대역
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Choseong
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals, Symbols (U+3000 전각 공백 포함)
    (cp >= 0x3040 && cp <= 0x33bf) || // Hiragana, Katakana, Hangul Compatibility Jamo (0x3130..0x318F)
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK Unified Ideographs
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables (가~힣)
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth ASCII variants
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // Misc Symbols & Pictographs / Emoji
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

/**
 * 일부 터미널의 CJK Ambiguous Width 옵션에서도 커서가 밀리지 않도록
 * 강제 커서 동기화 대상이 되는 기하/특수 기호인지 판별합니다.
 */
export function isAmbiguousSymbol(cp: number): boolean {
  // 박스 드로잉(0x2500..0x257f)과 블록 요소(0x2580..0x259f)를 제외한 기하 도형/화살표/딩뱃
  return (
    (cp >= 0x2190 && cp <= 0x21ff) || // 화살표
    (cp >= 0x25a0 && cp <= 0x27bf) || // ■, ◇, ●, ◉, ○, ▮, ▶, ▷, ▼, ◈, ✓ 등
    cp === 0x2014 || // —
    cp === 0x00b7 || // ·
    cp === 0x00bb    // »
  );
}

export function stringWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      w += codePointWidth(cp);
    }
  }
  return w;
}

export function truncateWidth(str: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(str) <= maxWidth) return str;

  const ellW = stringWidth(ellipsis);
  if (maxWidth <= ellW) {
    return sliceByWidth(str, maxWidth);
  }

  const target = maxWidth - ellW;
  let acc = 0;
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    const cw = codePointWidth(cp);
    if (acc + cw > target) break;
    out += ch;
    acc += cw;
  }
  return out + ellipsis;
}

export function sliceByWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let acc = 0;
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    const cw = codePointWidth(cp);
    if (acc + cw > maxWidth) break;
    out += ch;
    acc += cw;
  }
  return out;
}

export function padRightWidth(str: string, targetWidth: number): string {
  const clipped = truncateWidth(str, targetWidth, '…');
  const w = stringWidth(clipped);
  return w < targetWidth ? clipped + ' '.repeat(targetWidth - w) : clipped;
}

export function padLeftWidth(str: string, targetWidth: number): string {
  const clipped = truncateWidth(str, targetWidth, '…');
  const w = stringWidth(clipped);
  return w < targetWidth ? ' '.repeat(targetWidth - w) + clipped : clipped;
}

export function centerWidth(str: string, targetWidth: number): string {
  const clipped = truncateWidth(str, targetWidth, '…');
  const w = stringWidth(clipped);
  if (w >= targetWidth) return clipped;
  const left = Math.floor((targetWidth - w) / 2);
  const right = targetWidth - w - left;
  return ' '.repeat(left) + clipped + ' '.repeat(right);
}

/**
 * 한글 어절 단위(word-break: keep-all)를 우선 존중하면서 지정된 셀 폭으로 줄바꿈합니다.
 */
export function wrapByWidth(text: string, maxWidth: number, maxLines = 10): string[] {
  if (maxWidth <= 0) return [];
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push('');
      continue;
    }
    const words = para.split(' ');
    let current = '';
    let currentW = 0;

    for (const word of words) {
      const wordW = stringWidth(word);
      if (current.length === 0) {
        if (wordW <= maxWidth) {
          current = word;
          currentW = wordW;
        } else {
          // 어절 자체가 maxWidth보다 길면 글자 단위로 분할
          let chunk = '';
          let chunkW = 0;
          for (const ch of word) {
            const cw = codePointWidth(ch.codePointAt(0) ?? 0);
            if (chunkW + cw > maxWidth) {
              lines.push(chunk);
              chunk = ch;
              chunkW = cw;
            } else {
              chunk += ch;
              chunkW += cw;
            }
          }
          current = chunk;
          currentW = chunkW;
        }
      } else if (currentW + 1 + wordW <= maxWidth) {
        current += ' ' + word;
        currentW += 1 + wordW;
      } else {
        lines.push(current);
        if (wordW <= maxWidth) {
          current = word;
          currentW = wordW;
        } else {
          let chunk = '';
          let chunkW = 0;
          for (const ch of word) {
            const cw = codePointWidth(ch.codePointAt(0) ?? 0);
            if (chunkW + cw > maxWidth) {
              lines.push(chunk);
              chunk = ch;
              chunkW = cw;
            } else {
              chunk += ch;
              chunkW += cw;
            }
          }
          current = chunk;
          currentW = chunkW;
        }
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }

  if (lines.length > maxLines) {
    const sliced = lines.slice(0, maxLines);
    sliced[maxLines - 1] = truncateWidth(sliced[maxLines - 1] ?? '', maxWidth, '…');
    return sliced;
  }
  return lines;
}
