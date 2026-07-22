import { describe, expect, it } from 'vitest';
import { onboardingBriefing, onboardingNudge, onboardingRetryHint, type OnboardingState } from '../assets/scripts/core/Onboarding';

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    levelIndex: 0,
    elapsedSec: 0,
    bestStars: 0,
    effectiveHits: 0,
    perfectHits: 0,
    huntProgress: 0,
    huntThreshold: 18,
    huntHoldSec: 2,
    ...overrides,
  };
}

describe('前三关渐进式教学', () => {
  it('第2关解释金色锁定，第3关解释猎杀阈值与维持时间', () => {
    expect(onboardingBriefing(state({ levelIndex: 1 }))).toContain('金色锁定');
    expect(onboardingBriefing(state({ levelIndex: 2 }))).toContain('≤18');
    expect(onboardingBriefing(state({ levelIndex: 2 }))).toContain('2 秒');
  });

  it('已经三星后不再重复开场教学', () => {
    expect(onboardingBriefing(state({ levelIndex: 1, bestStars: 3 }))).toBeNull();
    expect(onboardingNudge(state({ levelIndex: 2, elapsedSec: 30, bestStars: 3 }))).toBeNull();
  });

  it('迟迟没有目标进展时才给一次可执行提示', () => {
    expect(onboardingNudge(state({ elapsedSec: 9.9 }))).toBeNull();
    expect(onboardingNudge(state({ elapsedSec: 10 }))).toContain('改需求');
    expect(onboardingNudge(state({ levelIndex: 1, elapsedSec: 12 }))).toContain('金色锁定');
    expect(onboardingNudge(state({ levelIndex: 2, elapsedSec: 14 }))).toContain('返工卡');
  });

  it('目标已有进展后不会继续打扰玩家', () => {
    expect(onboardingNudge(state({ elapsedSec: 20, effectiveHits: 1 }))).toBeNull();
    expect(onboardingNudge(state({ levelIndex: 1, elapsedSec: 20, perfectHits: 1 }))).toBeNull();
    expect(onboardingNudge(state({ levelIndex: 2, elapsedSec: 20, huntProgress: 0.2 }))).toBeNull();
  });

  it('前三关失败后给出与本关心智一致的快速再战动作', () => {
    expect(onboardingRetryHint(0)).toContain('改需求');
    expect(onboardingRetryHint(1)).toContain('金色锁定');
    expect(onboardingRetryHint(2)).toContain('返工卡');
    expect(onboardingRetryHint(3)).toBeNull();
  });
});
