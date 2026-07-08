import { describe, it, expect } from 'vitest';
import {
  createProfile,
  applyRunResult,
  rankScore,
  rankOf,
  rankFromScore,
  RankLabels,
  buildReportText,
} from '../assets/scripts/core/profile';
import { LevelSequence, unlockedPropsUpTo, getLevel } from '../assets/scripts/core/config';
import type { RunReport } from '../assets/scripts/core/RunReport';

function mkReport(result: RunReport['result'], stars: number, levelIndex: number): RunReport {
  const def = LevelSequence[levelIndex] ?? LevelSequence[0];
  return {
    result,
    stars,
    levelIndex,
    levelId: def.id,
    levelTitle: def.title ?? def.id,
    peakApproval: 50,
    finalApproval: 50,
    timeUsedSec: 60,
    durationSec: def.durationSec,
    bossInspectionsFired: 0,
    maxCombo: 0,
    revived: false,
  };
}

describe('PlayerProfile 段位与累加', () => {
  it('初始档案：实习生段位、第1天', () => {
    const p = createProfile();
    expect(p.highestUnlockedLevel).toBe(0);
    expect(p.huntWinCount).toBe(0);
    expect(p.star3Uniques).toBe(0);
    expect(p.daysEmployed).toBe(1);
    expect(rankScore(p)).toBe(0);
    expect(rankOf(p)).toBe('intern');
  });

  it('段位阈值边界：21=打工人、51=卷王、101=反卷斗士、201=AI克星', () => {
    expect(rankFromScore(0)).toBe('intern');
    expect(rankFromScore(20)).toBe('intern');
    expect(rankFromScore(21)).toBe('worker');
    expect(rankFromScore(50)).toBe('worker');
    expect(rankFromScore(51)).toBe('involution');
    expect(rankFromScore(100)).toBe('involution');
    expect(rankFromScore(101)).toBe('anti-involution');
    expect(rankFromScore(200)).toBe('anti-involution');
    expect(rankFromScore(201)).toBe('ai-buster');
  });

  it('加权公式：猎杀×3 + 三星×1 + 关卡×0.5', () => {
    const p = createProfile();
    p.huntWinCount = 2; // 2*3 = 6
    p.star3Uniques = 3; // 3*1 = 3
    p.highestUnlockedLevel = 4; // 4*0.5 = 2
    expect(rankScore(p)).toBe(6 + 3 + 2); // 11 → 实习生
    expect(rankOf(p)).toBe('intern');
  });

  it('通关1星：解锁下一关，不计猎杀/三星', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-survive', 1, 0));
    expect(p.highestUnlockedLevel).toBe(1);
    expect(p.huntWinCount).toBe(0);
    expect(p.star3Uniques).toBe(0);
    expect(p.daysEmployed).toBe(2);
  });

  it('猎杀式通关：huntWinCount++', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-hunt', 1, 0));
    expect(p.huntWinCount).toBe(1);
    expect(rankScore(p)).toBe(3 + 0 + 0.5); // 3.5
  });

  it('三星通关：star3Uniques 仅在新关卡首次达成时累加', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-survive', 3, 0));
    expect(p.star3Uniques).toBe(1);
    expect(p.highestUnlockedLevel).toBe(1);

    // 重玩同关3星：不重复累加
    applyRunResult(p, 0, mkReport('win-survive', 3, 0));
    expect(p.star3Uniques).toBe(1);

    // 第3关首次3星：累加
    applyRunResult(p, 2, mkReport('win-survive', 3, 2));
    expect(p.star3Uniques).toBe(3);
  });

  it('失败/0星：不解锁新关、不计猎杀/三星', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('lose', 0, 0));
    expect(p.highestUnlockedLevel).toBe(0);
    expect(p.huntWinCount).toBe(0);
    expect(p.star3Uniques).toBe(0);
  });

  it('段位中文名', () => {
    expect(RankLabels.intern).toBe('实习生');
    expect(RankLabels['ai-buster']).toBe('AI克星');
  });

  it('战报文案：猎杀/生存/失败', () => {
    const p = createProfile();
    p.huntWinCount = 10; // 段位跳到卷王
    const hunt = mkReport('win-hunt', 3, 6);
    expect(buildReportText(p, hunt, 6)).toContain('把AI逼到当场崩溃被劝退');
    expect(buildReportText(p, hunt, 6)).toContain('入职第7天');

    const survive = mkReport('win-survive', 1, 2);
    expect(buildReportText(p, survive, 2)).toContain('死死扛住了AI的KPI攻势');

    const fail = mkReport('lose', 0, 3);
    expect(buildReportText(p, fail, 3)).toContain('AI已能替代你');
  });
});

describe('关卡序列与解锁节奏', () => {
  it('LevelSequence 有5关', () => {
    expect(LevelSequence).toHaveLength(5);
    expect(LevelSequence[0].id).toBe('level-1');
    expect(LevelSequence[4].id).toBe('level-5');
  });

  it('锯齿曲线：第3关时长最长(小高峰)、第4关最短(甜点)', () => {
    expect(LevelSequence[2].durationSec).toBeGreaterThan(LevelSequence[0].durationSec);
    expect(LevelSequence[3].durationSec).toBeLessThan(LevelSequence[0].durationSec);
  });

  it('初始认可度：第4甜点关最低(35)、第3小高峰最高(50)', () => {
    expect(LevelSequence[3].approvalInit).toBe(35);
    expect(LevelSequence[2].approvalInit).toBe(50);
  });

  it('§1.2 解锁节奏：1~4关只加需求+改需求、第5关解锁丢锅', () => {
    expect(unlockedPropsUpTo(0)).toEqual(expect.arrayContaining(['add-demand', 'change-demand']));
    expect(unlockedPropsUpTo(3)).toEqual(expect.arrayContaining(['add-demand', 'change-demand']));
    expect(unlockedPropsUpTo(3)).not.toContain('throw-pot');
    expect(unlockedPropsUpTo(4)).toContain('throw-pot');
  });

  it('getLevel 越界返回最后一关(无限模式兜底)', () => {
    expect(getLevel(-1).id).toBe('level-1');
    expect(getLevel(99).id).toBe('level-5');
  });

  it('Boss 在前5关全部禁用（§1.2 第16~20关才引入）', () => {
    for (let i = 0; i < 5; i++) {
      expect(LevelSequence[i].boss.enabled).toBe(false);
    }
  });
});
