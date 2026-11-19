export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function hex(code: string): RGB {
  const clean = code.startsWith('#') ? code.slice(1) : code;
  const num = Number.parseInt(clean, 16);
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * clamped),
    g: Math.round(a.g + (b.g - a.g) * clamped),
    b: Math.round(a.b + (b.b - a.b) * clamped),
  };
}

export function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/**
 * gemini_sub_neon.html의 CSS :root 컬러 팔레트 및 파생 배경/보더 컬러 매핑
 */
export const THEME = {
  bg: hex('#1b2026'),
  bgChrome: hex('#252a32'),
  bgElevated: hex('#20262e'),
  bgModal: hex('#171c22'),
  bgGlowPurple: hex('#242132'),
  bgGlowNeon: hex('#26261e'),
  bgTriggerActive: hex('#322f44'),
  bgInputFocus: hex('#212933'),
  bgGreenTrack: hex('#2b3d34'),
  bgOrangeTrack: hex('#3c3029'),
  bgBlueTrack: hex('#293342'),
  bgNeonTrack: hex('#3b3928'),

  fg: hex('#d6dce3'),
  fgSoft: hex('#aeb6c2'),
  muted: hex('#89919b'),
  dim: hex('#69727f'),
  chromeFg: hex('#717a87'),

  borderHeader: hex('#4c535c'),
  borderWire: hex('#505761'),
  borderAdvisoryIdle: hex('#5a5668'),
  borderAsideDash: hex('#53505f'),
  borderLog: hex('#454c56'),
  borderFocusBoost: hex('#eef3f8'),

  orange: hex('#e9a17c'), // Argon · 리드
  blue: hex('#93b9ef'),   // Hydrogen · 스웜
  green: hex('#8cd5ae'),  // Decision 1 · 분기
  purple: hex('#bda6ef'), // Carbon · 자문
  neon: hex('#e8d97a'),   // Gemini Neon · 교차 검증

  trafficRed: hex('#f16e69'),
  trafficYellow: hex('#edbd54'),
  trafficGreen: hex('#65c785'),
} as const;

export type AgentColorKey = 'orange' | 'blue' | 'green' | 'purple' | 'neon' | 'muted' | 'fg';

export function resolveColorKey(key: AgentColorKey): RGB {
  switch (key) {
    case 'orange':
      return THEME.orange;
    case 'blue':
      return THEME.blue;
    case 'green':
      return THEME.green;
    case 'purple':
      return THEME.purple;
    case 'neon':
      return THEME.neon;
    case 'muted':
      return THEME.muted;
    case 'fg':
      return THEME.fg;
  }
}
