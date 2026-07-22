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

  it('Boss 关使用清晰且递进的固定临检节拍', () => {
    const bossLevels = LevelSequence.filter((level) => level.boss.enabled);
    expect(bossLevels).toHaveLength(6);
    bossLevels.forEach((level) => {
      expect(level.boss.scheduleSec?.length).toBeGreaterThan(0);
      expect(level.boss.patternLabel?.length).toBeGreaterThan(6);
      expect(level.boss.scheduleSec).toEqual([...(level.boss.scheduleSec ?? [])].sort((a, b) => a - b));
      expect((level.boss.scheduleSec ?? []).every((sec) => sec > 0 && sec < level.durationSec)).toBe(true);
    });
    expect(getLevel(9).boss.scheduleSec).toEqual([24]);
    expect(getLevel(9).boss.inspectionLimit).toBe(2);
    expect(getLevel(15).boss.inspectionLimit).toBe(2);
    expect(getLevel(16).boss.inspectionLimit).toBe(3);
    expect(getLevel(17).boss.inspectionLimit).toBe(3);
    expect(getLevel(18).boss.inspectionLimit).toBe(2);
    expect(getLevel(19).boss.inspectionLimit).toBeUndefined();
    expect(getLevel(17).boss.scheduleSec).toHaveLength(3);
    expect(getLevel(19).boss.scheduleSec).toHaveLength(3);
  });

  it('L11 起引入任务变体，后期 Boss 使用不同入场机制', () => {
    expect(LevelSequence.slice(0, 10).every((level) => !level.taskModifiers)).toBe(true);
    expect(LevelSequence.slice(10).every((level) => !!level.taskModifiers)).toBe(true);
    expect(getLevel(10).taskModifiers?.maxElite).toBe(1);
    expect(getLevel(17).taskModifiers?.eliteRatio.crisis).toBeGreaterThan(getLevel(10).taskModifiers?.eliteRatio.crisis ?? 0);
    expect(getLevel(15).boss.arrivalEffect).toBe('escalate-highest');
    expect(getLevel(16).boss.arrivalEffect).toBe('fortify-highest');
    expect(getLevel(17).boss.arrivalEffect).toBe('fortify-all');
    expect(getLevel(19).boss.arrivalEffect).toBe('fortify-all');
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
