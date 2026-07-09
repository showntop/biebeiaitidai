import type { BalanceConfigT, LevelDef } from '../config';
import type { GameResult } from '../types';

/** 一局结束时的统计快照（用于星级评价）。 */
export interface RunStats {
  peakApproval: number; // 全程认可度峰值
  timeUsedSec: number; // 实际用时
  bossInspectionsFired: number; // 触发过的 Boss 临检次数
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
    // ★★★（示例专属挑战，关卡可覆写）：猎杀通关且用时<配置阈值，或全程未让 Boss 临检生效
    const challenge =
      (result === 'win-hunt' && stats.timeUsedSec < this.cfg.stars.huntFastWinSec) ||
      stats.bossInspectionsFired === 0;
    if (challenge) stars = 3;
    return stars;
  }
}
