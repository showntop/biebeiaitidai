/**
 * 玩家跨关进度档案 —— 对应《别让AI替代你-关卡节奏与IAA社交裂变方案》§3.2 段位 + §1.5 失败重试顺畅性。
 *
 * 设计纪律：纯 TS，零 Cocos 依赖。存储序列化由表现层负责（如 wx.setStorageSync / LocalStorage），
 *           core 仅维护数据结构与累加逻辑，便于单测。
 */
import { LevelSequence } from './config';
import type { GameResult } from './types';
import type { RunReport } from './RunReport';

/** §3.2 段位档（加权分分档，权重向"猎杀次数"倾斜）。 */
export const Rank = {
  Intern: 'intern', // 实习生 0~20
  Worker: 'worker', // 打工人 21~50
  Involution: 'involution', // 卷王 51~100
  AntiInvolution: 'anti-involution', // 反卷斗士 101~200
  AIBuster: 'ai-buster', // AI克星 200+
} as const;
export type Rank = (typeof Rank)[keyof typeof Rank];

/** 段位分档表（策划文档§3.2，示例待 M4 校准）。 */
export const RankThresholds: { rank: Rank; lo: number; hi: number }[] = [
  { rank: 'intern', lo: 0, hi: 20 },
  { rank: 'worker', lo: 21, hi: 50 },
  { rank: 'involution', lo: 51, hi: 100 },
  { rank: 'anti-involution', lo: 101, hi: 200 },
  { rank: 'ai-buster', lo: 201, hi: Number.MAX_SAFE_INTEGER },
];

/** §3.2 段位加权公式：猎杀式通关×3 + 三星关卡×1 + 最高解锁关卡×0.5。 */
export interface PlayerProfile {
  /** §1.0 当前最高解锁关卡的序号（0-based，0=第1关已解锁）。 */
  highestUnlockedLevel: number;
  /** §3.2 累计猎杀式通关次数。 */
  huntWinCount: number;
  /** §3.2 累计获得三星的关卡序号集合（去重源真值，可序列化；同一关多次三星只记一次）。 */
  star3Levels: number[];
  /** §3.2 叙事包装"入职第N天"= 最高通关关卡序号 + 1。 */
  get daysEmployed(): number;
}

/** 三星关卡去重计数（= star3Levels.length）。 */
export function star3Count(p: PlayerProfile): number {
  return p.star3Levels.length;
}

/**
 * 从持久化数据（如 JSON.parse 回来的纯对象）重建一个完整 PlayerProfile。
 * 必要性：daysEmployed 是定义在对象字面量上的 getter，JSON 序列化/反序列化会丢失它，
 * 直接用反序列化对象会导致 profile.daysEmployed === undefined。这里用 createProfile()
 * 重新生成带 getter 的骨架并拷贝数据字段，保证跨存档读写一致。
 */
export function hydrateProfile(raw: Partial<PlayerProfile> | null): PlayerProfile {
  const p = createProfile();
  if (!raw) return p;
  p.highestUnlockedLevel = typeof raw.highestUnlockedLevel === 'number' ? raw.highestUnlockedLevel : 0;
  p.huntWinCount = typeof raw.huntWinCount === 'number' ? raw.huntWinCount : 0;
  p.star3Levels = Array.isArray(raw.star3Levels) ? [...raw.star3Levels] : [];
  return p;
}

/** 创建初始玩家档案（M2 首次进入游戏时调用）。 */
export function createProfile(): PlayerProfile {
  return {
    highestUnlockedLevel: 0,
    huntWinCount: 0,
    star3Levels: [],
    get daysEmployed() {
      return this.highestUnlockedLevel + 1;
    },
  };
}

/** §3.2 段位加权分。 */
export function rankScore(p: PlayerProfile): number {
  return p.huntWinCount * 3 + star3Count(p) * 1 + p.highestUnlockedLevel * 0.5;
}

/** §3.2 根据加权分查段位。 */
export function rankOf(p: PlayerProfile): Rank {
  const score = rankScore(p);
  for (const t of RankThresholds) {
    if (score >= t.lo && score <= t.hi) return t.rank;
  }
  return 'intern';
}

/**
 * 单关结算后更新档案。
 * - 失败 / 0 星：不解锁新关、不计猎杀/三星
 * - 1+ 星通关：解锁下一关（highestUnlockedLevel = max(旧, 本关+1)）
 * - 猎杀式通关：huntWinCount++（不论星级）
 * - 3 星：star3Levels 记录本关序号（去重，同一关多次三星只记一次）
 *
 * @param profile 当前档案（会被就地修改）
 * @param levelIndex 本关序号（0-based）
 * @param report 本关结算报告
 * @returns 更新后的档案（同引用）
 */
export function applyRunResult(profile: PlayerProfile, levelIndex: number, report: RunReport): PlayerProfile {
  if (report.result === 'lose' || report.stars === 0) return profile;

  // 解锁下一关
  if (levelIndex + 1 > profile.highestUnlockedLevel && levelIndex + 1 < LevelSequence.length) {
    profile.highestUnlockedLevel = levelIndex + 1;
  }
  // 猎杀式通关
  if (report.result === 'win-hunt') profile.huntWinCount++;
  // 三星（首次）：本关首次拿三星才记入集合
  if (report.stars === 3 && !profile.star3Levels.includes(levelIndex)) {
    profile.star3Levels.push(levelIndex);
  }
  return profile;
}

/** 段位中文名（用于 UI）。 */
export const RankLabels: Record<Rank, string> = {
  intern: '实习生',
  worker: '打工人',
  involution: '卷王',
  'anti-involution': '反卷斗士',
  'ai-buster': 'AI克星',
};

/** 段位判定辅助（纯函数版，给单测用）。 */
export function rankFromScore(score: number): Rank {
  for (const t of RankThresholds) {
    if (score >= t.lo && score <= t.hi) return t.rank;
  }
  return 'intern';
}

/** §3.3 战报文案生成（占位纯文本，美术卡片由表现层渲染）。 */
export function buildReportText(p: PlayerProfile, report: RunReport, levelIndex: number): string {
  const day = levelIndex + 1;
  const rank = RankLabels[rankOf(p)];
  if (report.result === 'win-hunt') {
    return `入职第${day}天，我把AI逼到当场崩溃被劝退，段位：${rank}`;
  }
  if (report.result === 'win-survive') {
    return `入职第${day}天，死死扛住了AI的KPI攻势，段位：${rank}`;
  }
  return `入职第${day}天，AI已能替代你，段位：${rank}`;
}

/** 显式标注 GameResult 类型用于类型守卫（防止 typo）。 */
export type { GameResult };
