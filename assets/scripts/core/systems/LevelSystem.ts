import type { BalanceConfigT, LevelDef } from '../config';
import type { GameResult, PropType } from '../types';

/** 一局结束时的统计快照（用于星级评价）。 */
export interface RunStats {
  peakApproval: number; // 全程认可度峰值
  timeUsedSec: number; // 实际用时
  bossInspectionsFired: number; // 触发过的 Boss 临检次数
  maxCombo?: number;
  effectiveHits?: number;
  perfectHits?: number;
  missedThrows?: number;
  propHits?: Partial<Record<PropType, number>>;
}

/**
 * 关卡系统（核心规则层，对应策划文档§6.2 星级 + §1.0 关卡数据）。
 *
 * 持有关卡定义（时长/挡位数/分布/Boss规则），并提供星级评价。
 * 三星中的"本关专属挑战"为示例实现（关卡可覆写），此处给出可复现的默认判定。
 */
export class LevelSystem {
  constructor(private cfg: BalanceConfigT, public def: LevelDef) {}

  /** §6.2 星级评价（两条胜利路径共用）。失败返回 0。 */
  starRating(result: GameResult, stats: RunStats): number {
    if (result === 'lose') return 0;
    let stars = 1;
    // ★★：全程未进危险区（峰值<70）；猎杀式通关自动满足
    const neverDanger = stats.peakApproval < this.cfg.zones.danger.lo || result === 'win-hunt';
    if (neverDanger) stars = 2;
    // ★★★：有专属目标时严格按本关目标；旧关卡仍保留兼容兜底。
    const challenge = this.def.objective
      ? this.objectiveMet(result, stats)
      : (result === 'win-hunt' && stats.timeUsedSec < this.cfg.stars.huntFastWinSec)
        || stats.bossInspectionsFired === 0;
    if (challenge) stars = 3;
    return stars;
  }

  objectiveMet(result: GameResult, stats: RunStats): boolean {
    if (result === 'lose') return false;
    const objective = this.def.objective;
    if (!objective) return true;
    const target = Math.max(1, objective.target ?? 1);
    switch (objective.kind) {
      case 'effective-hits': return (stats.effectiveHits ?? 0) >= target;
      case 'perfect': return (stats.perfectHits ?? 0) >= target;
      case 'combo': return (stats.maxCombo ?? 0) >= target;
      case 'hunt': return result === 'win-hunt';
      case 'boss-safe': return stats.bossInspectionsFired === 0;
      case 'no-miss': return (stats.missedThrows ?? 0) === 0;
      case 'use-prop': return !!objective.prop && (stats.propHits?.[objective.prop] ?? 0) >= target;
    }
  }
}
