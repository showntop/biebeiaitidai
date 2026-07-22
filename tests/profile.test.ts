import { describe, it, expect } from 'vitest';
import {
  createProfile,
  applyRunResult,
  rankScore,
  rankOf,
  rankFromScore,
  star3Count,
  bestStarsFor,
  totalStars,
  rankProgress,
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
    effectiveHits: 0,
    perfectHits: 0,
    missedThrows: 0,
    revived: false,
  };
}

describe('PlayerProfile 段位与累加', () => {
  it('初始档案：岗位保卫者段位、第1轮', () => {
    const p = createProfile();
    expect(p.highestUnlockedLevel).toBe(0);
    expect(p.huntWinCount).toBe(0);
    expect(star3Count(p)).toBe(0);
    expect(totalStars(p)).toBe(0);
    expect(p.daysEmployed).toBe(1);
    expect(rankScore(p)).toBe(0);
    expect(rankOf(p)).toBe('intern');
  });

  it('段位阈值边界：21=反替代打工人、51=AI干扰专家、101=反替代斗士、201=AI克星', () => {
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
    p.star3Levels = [0, 1, 2]; // 3 个三星关卡 → 3*1 = 3
    p.highestUnlockedLevel = 4; // 4*0.5 = 2
    expect(rankScore(p)).toBe(6 + 3 + 2); // 11 → 岗位保卫者
    expect(rankOf(p)).toBe('intern');
  });

  it('通关1星：解锁下一关，不计猎杀/三星', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-survive', 1, 0));
    expect(p.highestUnlockedLevel).toBe(1);
    expect(p.huntWinCount).toBe(0);
    expect(star3Count(p)).toBe(0);
    expect(p.daysEmployed).toBe(2);
  });

  it('猎杀式通关：huntWinCount++', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-hunt', 1, 0));
    expect(p.huntWinCount).toBe(1);
    expect(rankScore(p)).toBe(3 + 0 + 0.5); // 3.5
  });

  it('三星通关：star3Levels 去重记录本关序号', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-survive', 3, 0));
    expect(star3Count(p)).toBe(1);
    expect(p.star3Levels).toEqual([0]);
    expect(p.highestUnlockedLevel).toBe(1);

    // 重玩同关3星：不重复记录
    applyRunResult(p, 0, mkReport('win-survive', 3, 0));
    expect(star3Count(p)).toBe(1);
    expect(p.star3Levels).toEqual([0]);

    // 第3关首次3星：记录第3关 → 共 2 个三星关卡
    applyRunResult(p, 2, mkReport('win-survive', 3, 2));
    expect(star3Count(p)).toBe(2);
    expect(p.star3Levels).toEqual([0, 2]);
  });

  it('每关最佳星级只升不降，并累计总星', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('win-survive', 2, 0));
    applyRunResult(p, 0, mkReport('win-survive', 1, 0));
    applyRunResult(p, 1, mkReport('win-survive', 3, 1));
    expect(bestStarsFor(p, 0)).toBe(2);
    expect(bestStarsFor(p, 1)).toBe(3);
    expect(totalStars(p)).toBe(5);
  });

  it('三星分数不会因跳关虚高：只三星末关 → star3Count=1', () => {
    const p = createProfile();
    const last = LevelSequence.length - 1; // 末关 index
    applyRunResult(p, last, mkReport('win-survive', 3, last));
    expect(star3Count(p)).toBe(1); // 1 个三星关卡
    // 末关无法再解锁下一关(highestUnlockedLevel 仍 0)，分数 = 三星×1 = 1
    expect(rankScore(p)).toBe(1);
  });

  it('失败/0星：不解锁新关、不计猎杀/三星', () => {
    const p = createProfile();
    applyRunResult(p, 0, mkReport('lose', 0, 0));
    expect(p.highestUnlockedLevel).toBe(0);
    expect(p.huntWinCount).toBe(0);
    expect(star3Count(p)).toBe(0);
  });

  it('段位中文名', () => {
    expect(RankLabels.intern).toBe('岗位保卫者');
    expect(RankLabels['ai-buster']).toBe('AI克星');
  });

  it('段位成长进度：返回下一档距离，满级封顶', () => {
    const p = createProfile();
    p.huntWinCount = 5; // 15 分
    const progress = rankProgress(p);
    expect(progress.score).toBe(15);
    expect(progress.next).toBe('worker');
    expect(progress.remaining).toBe(6);
    expect(progress.ratio).toBeCloseTo(15 / 21);

    p.huntWinCount = 100;
    expect(rankProgress(p)).toMatchObject({ current: 'ai-buster', next: null, remaining: 0, ratio: 1 });
  });

  it('战报文案：猎杀/生存/失败', () => {
    const p = createProfile();
    p.huntWinCount = 10; // 段位跳到 AI干扰专家
    const hunt = mkReport('win-hunt', 3, 6);
    expect(buildReportText(p, hunt, 6)).toContain('把AI逼到当场崩溃被劝退');
    expect(buildReportText(p, hunt, 6)).toContain('第7轮反击');

    const survive = mkReport('win-survive', 1, 2);
    expect(buildReportText(p, survive, 2)).toContain('死死扛住了AI的KPI攻势');

    const fail = mkReport('lose', 0, 3);
    expect(buildReportText(p, fail, 3)).toContain('AI已经准备接管你的工作');
  });
});

describe('关卡序列与解锁节奏', () => {
  it('LevelSequence 有20关', () => {
    expect(LevelSequence).toHaveLength(20);
    expect(LevelSequence[0].id).toBe('level-1');
    expect(LevelSequence[4].id).toBe('level-5');
    expect(LevelSequence[9].id).toBe('level-10');
    expect(LevelSequence[19].id).toBe('level-20');
  });

  it('锯齿曲线：甜点关(L4)时长最短', () => {
    expect(LevelSequence[3].durationSec).toBeLessThan(LevelSequence[0].durationSec); // L4 甜点 < L1 标准
  });

  it('初始认可度：甜点关(L4)最低、第二小高峰(L9)较高', () => {
    expect(LevelSequence[3].approvalInit).toBe(35); // L4 甜点最低
    expect(LevelSequence[8].approvalInit).toBe(44); // L9 第二小高峰（调优后从47降到44）
    // L2/L3/L8 调优后降低
    expect(LevelSequence[1].approvalInit).toBe(40); // L2
    expect(LevelSequence[2].approvalInit).toBe(42); // L3
    expect(LevelSequence[7].approvalInit).toBe(44); // L8
  });

  it('错峰解锁：L1-4 加/改需求、L5 丢锅、L7 拍马屁、L8+ 全道具', () => {
    expect(unlockedPropsUpTo(0)).toEqual(expect.arrayContaining(['add-demand', 'change-demand']));
    expect(unlockedPropsUpTo(3)).not.toContain('throw-pot');
    expect(unlockedPropsUpTo(4)).toContain('throw-pot');
    expect(unlockedPropsUpTo(5)).not.toContain('kiss-up');
    expect(unlockedPropsUpTo(6)).toContain('kiss-up'); // L7 解锁拍马屁
    expect(unlockedPropsUpTo(7)).toHaveLength(4); // L8 起四道具齐全
  });

  it('getLevel 越界返回最后一关(无限模式兜底)', () => {
    expect(getLevel(-1).id).toBe('level-1');
    expect(getLevel(99).id).toBe('level-20');
  });

  it('Boss 仅第10关及L16+启用，前9关及L11-15禁用', () => {
    for (let i = 0; i < 9; i++) {
      expect(LevelSequence[i].boss.enabled).toBe(false);
    }
    expect(LevelSequence[9].boss.enabled).toBe(true); // L10
    for (let i = 10; i < 15; i++) {
      expect(LevelSequence[i].boss.enabled).toBe(false); // L11-15
    }
    for (let i = 15; i < 20; i++) {
      expect(LevelSequence[i].boss.enabled).toBe(true); // L16-20
    }
  });
});
