import { describe, expect, it } from 'vitest';
import { CareerChapters, chapterForLevel, nextStarMilestone } from '../assets/scripts/core/CareerRoute';
import { BalanceConfig, CardsConfig, LevelSequence, PropsConfig } from '../assets/scripts/core/config';
import { validateProjectConfig } from '../assets/scripts/core/ConfigValidation';
import { applyRunResult, createProfile } from '../assets/scripts/core/profile';
import type { RunReport } from '../assets/scripts/core/RunReport';

function report(levelIndex: number, stars: number): RunReport {
  const level = LevelSequence[levelIndex];
  return {
    result: 'win-survive',
    stars,
    levelIndex,
    levelId: level.id,
    levelTitle: level.title ?? level.id,
    peakApproval: 40,
    finalApproval: 30,
    timeUsedSec: level.durationSec,
    durationSec: level.durationSec,
    bossInspectionsFired: 0,
    maxCombo: 2,
    effectiveHits: 2,
    perfectHits: 0,
    missedThrows: 0,
    revived: false,
  };
}

describe('职业路线与星级奖励', () => {
  it('20 关按 4 章、每章 5 关组织', () => {
    expect(CareerChapters).toHaveLength(4);
    expect(CareerChapters.map((chapter) => chapter.endLevel - chapter.startLevel + 1)).toEqual([5, 5, 5, 5]);
    expect(chapterForLevel(0).id).toBe('survive');
    expect(chapterForLevel(9).id).toBe('counter');
    expect(chapterForLevel(19).id).toBe('finale');
  });

  it('下一星级奖励会随总星推进', () => {
    expect(nextStarMilestone(0)).toMatchObject({ stars: 6, label: '蓝色纸团' });
    expect(nextStarMilestone(6)).toMatchObject({ stars: 18, label: 'AI 崩溃表情' });
    expect(nextStarMilestone(36)).toBeNull();
  });

  it('达到星级门槛后收藏真实写入档案', () => {
    const profile = createProfile();
    applyRunResult(profile, 0, report(0, 3));
    applyRunResult(profile, 1, report(1, 3));
    expect(profile.cosmetics).toContain('paper-blue');
  });
});

describe('配置启动校验', () => {
  it('当前正式配置合法', () => {
    expect(validateProjectConfig({ cards: CardsConfig, props: PropsConfig, balance: BalanceConfig, levels: LevelSequence })).toEqual([]);
  });

  it('能定位概率和关卡字段错误', () => {
    const brokenProps = {
      ...PropsConfig,
      perfectRewards: PropsConfig.perfectRewards.map((reward) => ({ ...reward, p: 0 })),
    };
    const brokenLevel = { ...LevelSequence[0], objective: undefined };
    const errors = validateProjectConfig({
      cards: CardsConfig,
      props: brokenProps,
      balance: BalanceConfig,
      levels: [brokenLevel, ...LevelSequence.slice(1)],
    });
    expect(errors).toContain('props.perfectRewards probabilities must sum to 1');
    expect(errors).toContain('levels[0].objective.label is required');
  });
});
