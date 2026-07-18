import type { RunReport } from './RunReport';

export type ChallengeMode = 'daily' | 'friend';

export interface ChallengeSpec {
  version: 1;
  mode: ChallengeMode;
  levelIndex: number;
  seed: number;
  keyHash: number;
}

export type ShareCardVariant = 'hunt' | 'survive' | 'comeback' | 'last-stand';

export interface ShareCardMetric {
  label: string;
  value: string;
}

/** 与平台无关的战报图数据，所有指标统一为“越大越好”。 */
export interface ShareCardModel {
  variant: ShareCardVariant;
  eyebrow: string;
  title: string;
  subtitle: string;
  metrics: [ShareCardMetric, ShareCardMetric, ShareCardMetric];
  footer: string;
}

export interface SharePayload {
  title: string;
  query: string;
  challenge: ChallengeSpec;
  card: ShareCardModel;
}

export function createFriendChallenge(levelIndex: number, seed: number): ChallengeSpec {
  return makeChallenge('friend', levelIndex, seed, 'friend');
}

/** 同一个 YYYY-MM-DD 在所有设备上得到完全相同的关卡与 seed。 */
export function createDailyChallenge(dateKey: string): ChallengeSpec {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('dateKey must be YYYY-MM-DD');
  const hash = hash32(`daily:${dateKey}:v1`);
  return makeChallenge('daily', hash % 20, hash32(`seed:${dateKey}:v1`), dateKey);
}

export function localDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 短码格式：版本.模式.关卡.seed.keyHash.校验；可安全放入小游戏 query。 */
export function encodeChallenge(spec: ChallengeSpec): string {
  const body = [
    spec.version.toString(36),
    spec.mode === 'daily' ? 'd' : 'f',
    spec.levelIndex.toString(36),
    (spec.seed >>> 0).toString(36),
    (spec.keyHash >>> 0).toString(36),
  ].join('.');
  return `${body}.${(hash32(body) & 0xffff).toString(36)}`;
}

export function decodeChallenge(code: string | null | undefined): ChallengeSpec | null {
  if (!code || code.length > 96) return null;
  const parts = code.split('.');
  if (parts.length !== 6) return null;
  const [versionRaw, modeRaw, levelRaw, seedRaw, keyHashRaw, checksum] = parts;
  const body = parts.slice(0, 5).join('.');
  if ((hash32(body) & 0xffff).toString(36) !== checksum) return null;
  const version = parseInt(versionRaw, 36);
  const levelIndex = parseInt(levelRaw, 36);
  const seed = parseInt(seedRaw, 36);
  const keyHash = parseInt(keyHashRaw, 36);
  if (version !== 1 || (modeRaw !== 'd' && modeRaw !== 'f')) return null;
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= 20) return null;
  if (!Number.isFinite(seed) || seed < 0 || seed > 0xffffffff) return null;
  if (!Number.isFinite(keyHash) || keyHash < 0 || keyHash > 0xffffffff) return null;
  return {
    version: 1,
    mode: modeRaw === 'd' ? 'daily' : 'friend',
    levelIndex,
    seed: seed >>> 0,
    keyHash: keyHash >>> 0,
  };
}

export function parseChallengeQuery(search: string | undefined): ChallengeSpec | null {
  if (!search) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    if (decodeURIComponent(rawKey) === 'challenge') {
      return decodeChallenge(decodeURIComponent(rawValue));
    }
  }
  return null;
}

export function buildSharePayload(
  report: RunReport,
  rank: string,
  daysEmployed: number,
  seed: number,
): SharePayload {
  const challenge = createFriendChallenge(report.levelIndex, seed);
  const highlight = report.highlightTitle ?? (report.result === 'lose' ? '差一点守住' : '岗位守门员');
  const comeback = report.highlights?.some((id) => id === 'danger-comeback' || id === 'revive-comeback') ?? false;
  const variant: ShareCardVariant = report.result === 'win-hunt'
    ? 'hunt'
    : comeback
      ? 'comeback'
      : report.result === 'win-survive'
        ? 'survive'
        : 'last-stand';
  const title = variant === 'hunt'
    ? `我把 AI 反向优化了 · ${highlight}`
    : variant === 'comeback'
      ? `红区翻盘 · ${highlight}`
      : variant === 'survive'
        ? `工位守住了 · ${highlight}`
        : `差一点保住工位 · ${highlight}`;
  return {
    title,
    query: `challenge=${encodeURIComponent(encodeChallenge(challenge))}`,
    challenge,
    card: {
      variant,
      eyebrow: `第${report.levelIndex + 1}轮反击 · ${rank}`,
      title,
      subtitle: report.result === 'lose' ? '这局 AI 险胜，敢不敢接同一套任务？' : '同一套任务流，看看谁更会反替代。',
      metrics: [
        { label: '坚守时间', value: `${report.timeUsedSec.toFixed(1)}s` },
        { label: '最高连击', value: `${report.maxCombo}` },
        { label: 'Perfect', value: `${report.perfectHits}` },
      ],
      footer: `已坚守 ${daysEmployed} 天 · 挑战码 ${encodeChallenge(challenge).slice(-8).toUpperCase()}`,
    },
  };
}

function makeChallenge(mode: ChallengeMode, levelIndex: number, seed: number, key: string): ChallengeSpec {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= 20) throw new Error('invalid levelIndex');
  return { version: 1, mode, levelIndex, seed: seed >>> 0, keyHash: hash32(key) };
}

/** FNV-1a 32-bit：跨浏览器、小游戏和 Node 完全一致。 */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
