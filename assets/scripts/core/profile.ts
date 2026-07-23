/**
 * 玩家跨关进度档案 —— 对应《别让AI替代你-关卡节奏与IAA社交裂变方案》§3.2 段位 + §1.5 失败重试顺畅性。
 *
 * 设计纪律：纯 TS，零 Cocos 依赖。存储序列化由表现层负责（如 wx.setStorageSync / LocalStorage），
 *           core 仅维护数据结构与累加逻辑，便于单测。
 */
import { LevelSequence } from './config';
import type { GameResult } from './types';
import type { RunReport } from './RunReport';
import { StarMilestones } from './CareerRoute';

/** §3.2 段位档（加权分分档，权重向"猎杀次数"倾斜）。 */
export const Rank = {
  Intern: 'intern', // 岗位保卫者 0~20
  Worker: 'worker', // 反替代打工人 21~50
  Involution: 'involution', // AI干扰专家 51~100
  AntiInvolution: 'anti-involution', // 反替代斗士 101~200
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
  /** 每关历史最佳星级（0～3），用于总星收集与重玩反馈。 */
  bestStars: number[];
  /** 轻量成就与收藏均不改变战斗数值。 */
  achievements: AchievementId[];
  cosmetics: CosmeticId[];
  /** 仅保留最近 14 个每日挑战最佳成绩，避免存档无限增长。 */
  dailyRecords: DailyRecord[];
  /** 反替代进度编号 = 最高通关关卡序号 + 1。 */
  get daysEmployed(): number;
}

/** 三星关卡去重计数（= star3Levels.length）。 */
export function star3Count(p: PlayerProfile): number {
  return p.star3Levels.length;
}

export function bestStarsFor(p: PlayerProfile, levelIndex: number): number {
  return clampStars(p.bestStars[levelIndex]);
}

export function totalStars(p: PlayerProfile): number {
  return p.bestStars.reduce((sum, stars) => sum + clampStars(stars), 0);
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
  p.bestStars = Array.isArray(raw.bestStars)
    ? raw.bestStars.slice(0, LevelSequence.length).map(clampStars)
    : [];
  while (p.bestStars.length < LevelSequence.length) p.bestStars.push(0);
  // 旧存档只有三星关集合；迁移时至少恢复这些已经赢得的星级。
  for (const levelIndex of p.star3Levels) {
    if (levelIndex >= 0 && levelIndex < p.bestStars.length) p.bestStars[levelIndex] = 3;
  }
  p.achievements = Array.isArray(raw.achievements) ? raw.achievements.filter(isAchievementId) : [];
  p.cosmetics = Array.isArray(raw.cosmetics) ? raw.cosmetics.filter(isCosmeticId) : ['desk-classic'];
  p.dailyRecords = Array.isArray(raw.dailyRecords)
    ? raw.dailyRecords.filter((record): record is DailyRecord => !!record && typeof record.key === 'string' && typeof record.score === 'number').slice(-14)
    : [];
  return p;
}

/** 创建初始玩家档案（M2 首次进入游戏时调用）。 */
export function createProfile(): PlayerProfile {
  return {
    highestUnlockedLevel: 0,
    huntWinCount: 0,
    star3Levels: [],
    bestStars: new Array(LevelSequence.length).fill(0),
    achievements: [],
    cosmetics: ['desk-classic'],
    dailyRecords: [],
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
  awardRunAchievements(profile, report);
  if (report.result === 'lose' || report.stars === 0) return profile;

  profile.bestStars[levelIndex] = Math.max(bestStarsFor(profile, levelIndex), clampStars(report.stars));

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
  awardStarMilestones(profile);
  return profile;
}

/** 总星里程碑兑现为纯展示收藏，不改变战斗数值。 */
function awardStarMilestones(profile: PlayerProfile): void {
  const stars = totalStars(profile);
  for (const milestone of StarMilestones) {
    if (stars >= milestone.stars && !profile.cosmetics.includes(milestone.cosmetic)) {
      profile.cosmetics.push(milestone.cosmetic);
    }
  }
}

function clampStars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

export type AchievementId =
  | 'first-hunt'
  | 'perfect-chain'
  | 'boss-clutch'
  | 'flawless-survive'
  | 'combo-5'
  | 'daily-first';

export type CosmeticId = 'desk-classic' | 'paper-blue' | 'ai-crash-face' | 'report-gold';

export const CosmeticLabels: Record<CosmeticId, string> = {
  'desk-classic': '经典工位',
  'paper-blue': '蓝色纸团',
  'ai-crash-face': 'AI 崩溃表情',
  'report-gold': '金色战报纸',
};

export interface DailyRecord {
  key: string;
  score: number;
  result: GameResult;
  highlightTitle?: string;
}

export const AchievementLabels: Record<AchievementId, string> = {
  'first-hunt': '第一次反向优化',
  'perfect-chain': '三连 Perfect',
  'boss-clutch': '老板门口截胡',
  'flawless-survive': '无失误生存',
  'combo-5': '五连流程粉碎',
  'daily-first': '今日也没被替代',
};

/** 成就条件用于收藏页展示；规则仍以 awardRunAchievements 为唯一判定源。 */
export const AchievementHints: Record<AchievementId, string> = {
  'first-hunt': '完成 1 次猎杀式通关',
  'perfect-chain': '单局连续命中 3 次 Perfect',
  'boss-clutch': '在 Boss 临检前完成关键截胡',
  'flawless-survive': '零失误完成生存通关',
  'combo-5': '单局达成 5 连击',
  'daily-first': '完成 1 次今日挑战',
};

export interface RankProgress {
  score: number;
  current: Rank;
  next: Rank | null;
  nextAt: number | null;
  remaining: number;
  ratio: number;
}

/** 当前段位内的成长进度，供开始页/结算页统一展示。 */
export function rankProgress(p: PlayerProfile): RankProgress {
  return rankProgressFromScore(rankScore(p));
}

/** 结算前的分数快照也可复用同一套段位进度计算。 */
export function rankProgressFromScore(score: number): RankProgress {
  const current = rankFromScore(score);
  const index = RankThresholds.findIndex((threshold) => threshold.rank === current);
  const threshold = RankThresholds[Math.max(0, index)];
  const nextThreshold = RankThresholds[index + 1];
  if (!nextThreshold) {
    return { score, current, next: null, nextAt: null, remaining: 0, ratio: 1 };
  }
  const span = Math.max(1, nextThreshold.lo - threshold.lo);
  return {
    score,
    current,
    next: nextThreshold.rank,
    nextAt: nextThreshold.lo,
    remaining: Math.max(0, nextThreshold.lo - score),
    ratio: Math.max(0, Math.min(1, (score - threshold.lo) / span)),
  };
}

/** 每日挑战只比较正分；相同 key 只保留更高成绩。 */
export function applyDailyChallengeResult(profile: PlayerProfile, key: string, report: RunReport): number {
  const score = challengeScore(report);
  const old = profile.dailyRecords.find((record) => record.key === key);
  if (!old || score > old.score) {
    const next: DailyRecord = { key, score, result: report.result, highlightTitle: report.highlightTitle };
    profile.dailyRecords = profile.dailyRecords.filter((record) => record.key !== key);
    profile.dailyRecords.push(next);
    if (profile.dailyRecords.length > 14) profile.dailyRecords.splice(0, profile.dailyRecords.length - 14);
  }
  unlock(profile, 'daily-first', 'paper-blue');
  awardRunAchievements(profile, report);
  return score;
}

export function challengeScore(report: RunReport): number {
  const resultBase = report.result === 'win-hunt' ? 1400 : report.result === 'win-survive' ? 1000 : 250;
  return Math.round(
    resultBase
    + report.timeUsedSec * 2
    + report.maxCombo * 60
    + report.perfectHits * 100
    + report.effectiveHits * 15
    + Math.max(0, 100 - report.finalApproval) * 3,
  );
}

function awardRunAchievements(profile: PlayerProfile, report: RunReport): void {
  if (report.result === 'win-hunt') unlock(profile, 'first-hunt', 'report-gold');
  if (report.highlights?.includes('perfect-chain')) unlock(profile, 'perfect-chain', 'paper-blue');
  if (report.highlights?.includes('boss-clutch')) unlock(profile, 'boss-clutch', 'report-gold');
  if (report.result === 'win-survive' && report.missedThrows === 0) unlock(profile, 'flawless-survive', 'paper-blue');
  if (report.maxCombo >= 5) unlock(profile, 'combo-5', 'ai-crash-face');
}

function unlock(profile: PlayerProfile, achievement: AchievementId, cosmetic: CosmeticId): void {
  if (!profile.achievements.includes(achievement)) profile.achievements.push(achievement);
  if (!profile.cosmetics.includes(cosmetic)) profile.cosmetics.push(cosmetic);
}

function isAchievementId(value: unknown): value is AchievementId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AchievementLabels, value);
}

function isCosmeticId(value: unknown): value is CosmeticId {
  return value === 'desk-classic' || value === 'paper-blue' || value === 'ai-crash-face' || value === 'report-gold';
}

/** 段位中文名（用于 UI）。 */
export const RankLabels: Record<Rank, string> = {
  intern: '岗位保卫者',
  worker: '反替代打工人',
  involution: 'AI干扰专家',
  'anti-involution': '反替代斗士',
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
  const highlight = report.highlightTitle ? `「${report.highlightTitle}」` : '';
  if (report.result === 'win-hunt') {
    return `第${day}轮反击${highlight}，我把AI逼到当场崩溃被劝退，段位：${rank}`;
  }
  if (report.result === 'win-survive') {
    return `第${day}轮反击${highlight}，死死扛住了AI的KPI攻势，段位：${rank}`;
  }
  return `第${day}轮反击${highlight}，AI已经准备接管你的工作，下次把工位抢回来，段位：${rank}`;
}

/** 显式标注 GameResult 类型用于类型守卫（防止 typo）。 */
export type { GameResult };
