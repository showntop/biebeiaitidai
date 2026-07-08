/**
 * 单局结算战报 —— 对应《别让AI替代你-关卡节奏与IAA社交裂变方案》§3.3 战报分享 + §6.2 星级评价。
 *
 * 一局结束时由 Game 收集，作为：
 *  - PlayerProfile 累加依据（applyRunResult 入参）
 *  - 战报卡片渲染数据
 *  - M4 模拟验收统计源
 */
import type { GameResult } from './types';

/** 一局结束后的统计快照（不可变，作为战报数据源）。 */
export interface RunReport {
  /** §6.2 胜负结果。 */
  result: GameResult;
  /** §6.2 星级（0=失败 / 1=通关 / 2=全程未进危险 / 3=专属挑战）。 */
  stars: number;
  /** 本关序号（0-based）。 */
  levelIndex: number;
  /** 关卡 id（如 "level-1"）。 */
  levelId: string;
  /** §3.3 关卡叙事标题（"入职第N天"）。 */
  levelTitle: string;
  /** 全程认可度峰值。 */
  peakApproval: number;
  /** 结算时认可度。 */
  finalApproval: number;
  /** 实际用时（秒）。 */
  timeUsedSec: number;
  /** 本关时长（秒，便于计算"剩余时间"展示）。 */
  durationSec: number;
  /** §5.4 触发过的 Boss 临检次数。 */
  bossInspectionsFired: number;
  /** §4.4 最高连击数。 */
  maxCombo: number;
  /** 是否使用了复活（§2.1）。 */
  revived: boolean;
}

/** 从 Game 实例收集结算报告（Game 结束后调用）。 */
export interface RunReportInput {
  result: GameResult;
  stars: number;
  levelIndex: number;
  levelId: string;
  levelTitle: string;
  peakApproval: number;
  finalApproval: number;
  timeUsedSec: number;
  durationSec: number;
  bossInspectionsFired: number;
  maxCombo: number;
  revived: boolean;
}

export function buildRunReport(input: RunReportInput): RunReport {
  return { ...input };
}

/** §3.3 战报简要文本（用于分享/日志）。 */
export function summarizeReport(r: RunReport): string {
  const verdict =
    r.result === 'win-hunt' ? '猎杀通关' : r.result === 'win-survive' ? '生存通关' : '失败';
  return `[${r.levelTitle}] ${verdict} ★${r.stars} | 峰值${Math.round(r.peakApproval)} | ${r.timeUsedSec.toFixed(1)}s | Boss临检${r.bossInspectionsFired} | 连击${r.maxCombo}`;
}
