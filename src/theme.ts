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
 * dgate 고유 "Obsidian Signal" 팔레트 — 정밀 관제 콘솔 톤
 * 깊은 옵시디언 캔버스 + 고대비 시그널(앰버·시안·틸에메랄드·바이올렛·골드)
 */
export const THEME = {
  bg: hex('#0e1015'),
  bgChrome: hex('#14171f'),
  bgElevated: hex('#171b24'),
  bgModal: hex('#11141c'),
  bgGlowPurple: hex('#191626'),
  bgGlowNeon: hex('#1b1a14'),
  bgTriggerActive: hex('#241f36'),
  bgInputFocus: hex('#161e29'),
  bgGreenTrack: hex('#152c26'),
  bgOrangeTrack: hex('#2c1e16'),
  bgBlueTrack: hex('#152534'),
  bgNeonTrack: hex('#282414'),

  fg: hex('#edf0f5'),
  fgSoft: hex('#b8c0ce'),
  muted: hex('#7d8799'),
  dim: hex('#545d6e'),
  chromeFg: hex('#6c768a'),

  borderHeader: hex('#2c3342'),
  borderWire: hex('#384154'),
  borderAdvisoryIdle: hex('#3c3650'),
  borderAsideDash: hex('#332e44'),
  borderLog: hex('#262c3a'),
  borderFocusBoost: hex('#f8fafc'),

  orange: hex('#f59e0b'), // Lead · 리드 (Amber Signal)
  blue: hex('#38bdf8'),   // Workers · 스웜 (Cyan-Sky Telemetry)
  green: hex('#2dd4bf'),  // Decision Gate · 분기 (Emerald-Teal Gate)
  purple: hex('#c084fc'), // Advisor · 자문 (Electric Violet)
  neon: hex('#facc15'),   // Verifier · 교차 검증 (Precision Gold)

  trafficRed: hex('#fb7185'),
  trafficYellow: hex('#fbbf24'),
  trafficGreen: hex('#34d399'),
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
    default:
      return THEME.fg;
  }
}
