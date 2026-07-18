import { describe, expect, it } from 'vitest';
import {
  BalanceConfig,
  LevelSequence,
  allowedPropsForLevel,
  getLevel,
  unlockedPropsUpTo,
} from '../assets/scripts/core/config';
import { LevelSystem, type RunStats } from '../assets/scripts/core/systems/LevelSystem';
import { PropType as PT } from '../assets/scripts/core/types';

const safeRun = (overrides: Partial<RunStats> = {}): RunStats => ({
  peakApproval: 55,
  timeUsedSec: 60,
  bossInspectionsFired: 0,
  maxCombo: 0,
  effectiveHits: 0,
  perfectHits: 0,
  missedThrows: 0,
  propHits: {},
  ...overrides,
});

describe('P3 · 前 10 分钟内容节奏', () => {
  it('20 关都有玩家目标和下一关钩子', () => {
    expect(LevelSequence).toHaveLength(20);
    LevelSequence.forEach((level) => {
      expect(level.objective?.label.length).toBeGreaterThan(3);
      expect(level.hook?.length).toBeGreaterThan(6);
    });
  });

  it('1～3 关只教基础双道具且不叠 Boss', () => {
    for (let index = 0; index < 3; index++) {
      expect(allowedPropsForLevel(index)).toEqual([PT.AddDemand, PT.ChangeDemand]);
      expect(getLevel(index).boss.enabled).toBe(false);
    }
  });

  it('5/7/10 关依次引入甩锅、拍马屁与 Boss', () => {
    expect(allowedPropsForLevel(3)).not.toContain(PT.ThrowPot);
    expect(allowedPropsForLevel(4)).toContain(PT.ThrowPot);
    expect(allowedPropsForLevel(5)).not.toContain(PT.KissUp);
    expect(allowedPropsForLevel(6)).toContain(PT.KissUp);
    expect(LevelSequence.slice(0, 9).every((level) => !level.boss.enabled)).toBe(true);
    expect(getLevel(9).boss.enabled).toBe(true);
  });

  it('11～20 关包含固定任务流、限道具和多类挑战', () => {
    const late = LevelSequence.slice(10);
    expect(late.filter((level) => typeof level.fixedSeed === 'number')).toHaveLength(5);
    expect(late.filter((level) => level.propLimit?.length)).toHaveLength(3);
    expect(new Set(late.map((level) => level.objective?.kind)).size).toBeGreaterThanOrEqual(5);
    late.forEach((level, offset) => {
      const index = offset + 10;
      const unlocked = unlockedPropsUpTo(index);
      expect(allowedPropsForLevel(index).every((prop) => unlocked.includes(prop))).toBe(true);
      expect(allowedPropsForLevel(index).length).toBeGreaterThan(0);
    });
  });
});

describe('P3 · 专属三星目标', () => {
  it('Perfect 关未达目标只有两星，达标升三星', () => {
    const level = new LevelSystem(BalanceConfig, getLevel(1));
    expect(level.starRating('win-survive', safeRun({ perfectHits: 0 }))).toBe(2);
    expect(level.starRating('win-survive', safeRun({ perfectHits: 1 }))).toBe(3);
  });

  it('猎杀目标必须走猎杀路径', () => {
    const level = new LevelSystem(BalanceConfig, getLevel(2));
    expect(level.starRating('win-survive', safeRun())).toBe(2);
    expect(level.starRating('win-hunt', safeRun())).toBe(3);
  });

  it('指定道具目标按实际命中计数', () => {
    const level = new LevelSystem(BalanceConfig, getLevel(4));
    expect(level.objectiveMet('win-survive', safeRun())).toBe(false);
    expect(level.objectiveMet('win-survive', safeRun({ propHits: { [PT.ThrowPot]: 1 } }))).toBe(true);
  });

  it('失败永远不会因目标统计获得星级', () => {
    const level = new LevelSystem(BalanceConfig, getLevel(14));
    expect(level.starRating('lose', safeRun({ maxCombo: 99 }))).toBe(0);
  });
});
