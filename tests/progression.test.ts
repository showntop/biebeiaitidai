import { describe, expect, it } from 'vitest';
import {
  applyDailyChallengeResult,
  applyRunResult,
  challengeScore,
  createProfile,
  CosmeticLabels,
  hydrateProfile,
} from '../assets/scripts/core/profile';
import { createDailyChallenge } from '../assets/scripts/core/SocialChallenge';
import { InMemoryStorage, Session } from '../assets/scripts/core/Session';
import type { RunReport } from '../assets/scripts/core/RunReport';

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    result: 'win-survive',
    stars: 3,
    levelIndex: 0,
    levelId: 'level-1',
    levelTitle: '第1轮反击',
    peakApproval: 60,
    finalApproval: 32,
    timeUsedSec: 60,
    durationSec: 60,
    bossInspectionsFired: 0,
    maxCombo: 5,
    effectiveHits: 8,
    perfectHits: 3,
    missedThrows: 0,
    revived: false,
    highlights: ['perfect-chain', 'boss-clutch'],
    highlightTitle: '门口截胡',
    ...overrides,
  };
}

describe('轻量成长与每日挑战', () => {
  it('收藏奖励都有可直接用于结算页的中文名称', () => {
    expect(Object.keys(CosmeticLabels)).toEqual(['desk-classic', 'paper-blue', 'ai-crash-face', 'report-gold']);
  });
  it('高光解锁成就和外观，但不重复累计', () => {
    const profile = createProfile();
    applyRunResult(profile, 0, report());
    applyRunResult(profile, 0, report());
    expect(profile.achievements).toEqual(expect.arrayContaining([
      'perfect-chain', 'boss-clutch', 'flawless-survive', 'combo-5',
    ]));
    expect(new Set(profile.achievements).size).toBe(profile.achievements.length);
    expect(profile.cosmetics).toEqual(expect.arrayContaining(['desk-classic', 'paper-blue', 'ai-crash-face', 'report-gold']));
  });

  it('每日同 key 只保留更高分，记录最多保留 14 天', () => {
    const profile = createProfile();
    const low = report({ result: 'lose', stars: 0, maxCombo: 0, perfectHits: 0, effectiveHits: 1, finalApproval: 100 });
    const high = report();
    applyDailyChallengeResult(profile, 'day-0', low);
    applyDailyChallengeResult(profile, 'day-0', high);
    applyDailyChallengeResult(profile, 'day-0', low);
    expect(profile.dailyRecords).toHaveLength(1);
    expect(profile.dailyRecords[0].score).toBe(challengeScore(high));
    for (let i = 1; i <= 16; i++) applyDailyChallengeResult(profile, `day-${i}`, high);
    expect(profile.dailyRecords).toHaveLength(14);
    expect(profile.dailyRecords.some((record) => record.key === 'day-0')).toBe(false);
  });

  it('Session 每日挑战持久化成绩但不解锁主线', () => {
    const storage = new InMemoryStorage();
    const session = new Session(storage);
    const daily = createDailyChallenge('2026-07-18');
    session.startChallenge(daily);
    session.finishLevel(report({ levelIndex: daily.levelIndex, levelId: `level-${daily.levelIndex + 1}` }));
    expect(session.profile.highestUnlockedLevel).toBe(0);
    expect(session.profile.dailyRecords).toHaveLength(1);
    expect(storage.loadProfile()?.achievements).toContain('daily-first');
    expect(session.lastProgression?.daily).toMatchObject({
      previousBest: null,
      firstAttempt: true,
      newRecord: true,
    });
    expect(session.lastProgression?.newAchievements).toContain('daily-first');
  });

  it('旧存档 hydrate 后自动补齐成长字段', () => {
    const hydrated = hydrateProfile({ highestUnlockedLevel: 3, huntWinCount: 1, star3Levels: [0] });
    expect(hydrated.achievements).toEqual([]);
    expect(hydrated.cosmetics).toEqual(['desk-classic']);
    expect(hydrated.dailyRecords).toEqual([]);
    expect(hydrated.bestStars).toHaveLength(20);
    expect(hydrated.bestStars[0]).toBe(3);
  });
});
