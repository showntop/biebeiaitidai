export interface OnboardingState {
  levelIndex: number;
  elapsedSec: number;
  bestStars: number;
  effectiveHits: number;
  perfectHits: number;
  huntProgress: number;
  huntThreshold: number;
  huntHoldSec: number;
}

/** 前三关首次/补星时的开场提示。短句只解释本关新增心智，不重复基础操作。 */
export function onboardingBriefing(state: OnboardingState): string | null {
  if (state.levelIndex === 1 && state.bestStars < 3) {
    return '教学 · 停在卡槽中心，金色锁定再松手';
  }
  if (state.levelIndex === 2 && state.bestStars < 3) {
    return `教学 · 认可度压到 ≤${state.huntThreshold}，稳住 ${state.huntHoldSec} 秒`;
  }
  return null;
}

/** 玩家一段时间仍无目标进展时，只补充一次“下一步做什么”，不暂停也不改规则。 */
export function onboardingNudge(state: OnboardingState): string | null {
  if (state.bestStars >= 3) return null;
  if (state.levelIndex === 0 && state.elapsedSec >= 10 && state.effectiveHits === 0) {
    return '教学 · 长按改需求 → 对准白卡 → 松手';
  }
  if (state.levelIndex === 1 && state.elapsedSec >= 12 && state.perfectHits === 0) {
    return '教学 · 停在卡槽中心，金色锁定再松手';
  }
  if (state.levelIndex === 2 && state.elapsedSec >= 14 && state.huntProgress < 0.05) {
    return '教学 · 红色返工卡进处理区 = 降认可度';
  }
  return null;
}

/** 前三关失败结算的快速再战提示，与局内教学使用同一套操作语言。 */
export function onboardingRetryHint(levelIndex: number): string | null {
  if (levelIndex === 0) return '长按“改需求”→对准白色任务卡→松手';
  if (levelIndex === 1) return '对准卡槽后停一下，金色锁定时再松手';
  if (levelIndex === 2) return '先制造红色返工卡，让它进入处理区降低认可度';
  return null;
}
