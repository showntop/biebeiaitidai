import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { LevelSystem } from '../assets/scripts/core/systems/LevelSystem';
import { BalanceConfig, DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { HitQuality as HQ, PropType as PT } from '../assets/scripts/core/types';
import type { GameResult } from '../assets/scripts/core/types';
import type { LevelDef } from '../assets/scripts/core/config';

/** 把一局跑到结束（或超时），返回关键结果。 */
function runGame(seed: number): { result: GameResult; peak: number; stars: number; elapsed: number } {
  const g = new Game(DefaultLevel, new SeededRng(seed));
  for (let t = 0; t < 90 && !g.over; t += 0.05) g.tick(0.05);
  return { result: g.result, peak: g.peakApproval, stars: g.stars, elapsed: g.elapsed };
}

describe('Game · 全局模拟', () => {
  it('60 秒标准关能在限时内终止，结果合法', () => {
    const r = runGame(123);
    expect(['win-survive', 'win-hunt', 'lose']).toContain(r.result);
    expect(r.elapsed).toBeLessThanOrEqual(60.5);
  });

  it('同种子完全可复现（确定性，M0 回归比对基础）', () => {
    const a = runGame(2024);
    const b = runGame(2024);
    expect(b.result).toBe(a.result);
    expect(b.peak).toBe(a.peak);
    expect(b.stars).toBe(a.stars);
    expect(b.elapsed).toBe(a.elapsed);
  });

  it('不同种子结果分布合理（多跑几个种子都正常终止）', () => {
    for (let s = 1; s <= 8; s++) {
      const r = runGame(s * 1000);
      expect(['win-survive', 'win-hunt', 'lose']).toContain(r.result);
    }
  });
});

describe('Game · 道具生效接线（CardHit → Conveyor 变更）', () => {
  it('改需求经 Game 释放后，传送带对应卡变返工卡', () => {
    const g = new Game(DefaultLevel, new SeededRng(5));
    // 在 slot0 放一张活跃白卡：固定槽位模型下 generate→入口(slot5)，需 step 把它走到 slot0
    const N = DefaultLevel.slots;
    g.conveyor.reset();
    let guard = 0;
    while (g.conveyor.slotAt(0)?.state !== 'active-white' && guard++ < 40) {
      g.conveyor.reset();
      g.conveyor.generate('early'); // 入口 slot(N-1)
      for (let i = 0; i < N - 1; i++) g.conveyor.step(); // 走到 slot0
    }
    expect(g.conveyor.slotAt(0)!.state).toBe('active-white');

    g.beginCharge(PT.ChangeDemand);
    g.tick(0.05); // 扫描推进到 slot0（不触发位移：0.05 < slotPeriod）
    g.release(PT.ChangeDemand);

    expect(g.conveyor.slotAt(0)!.state).toBe('rework'); // 经事件接线被污染
  });

  it('改需求命中的卡进入处理区后按负权重结算', () => {
    const g = new Game(DefaultLevel, new SeededRng(6));
    const before = g.approval.value;
    g.conveyor.cards[0] = {
      id: 7001,
      category: 'urgent',
      state: 'active-white',
      weight: 10,
      baseWeight: 10,
      isThreat: true,
    };

    expect(g.beginCharge(PT.ChangeDemand)).toBe(true);
    expect(g.releaseAtSlot(PT.ChangeDemand, 0, HQ.Normal)).toBe(true);
    expect(g.conveyor.slotAt(0)).toMatchObject({ state: 'rework', weight: 10, isThreat: false });

    g.conveyor.step();
    expect(g.approval.value).toBe(before - 10);
  });

  it('拖拽槽位释放可把 Perfect 质量传入规则层并记录战报', () => {
    const g = new Game(DefaultLevel, new SeededRng(5));
    g.beginCharge(PT.AddDemand);
    expect(g.releaseAtSlot(PT.AddDemand, 2, HQ.Perfect)).toBe(true);
    const report = g.buildReport(0);
    expect(report.effectiveHits).toBe(1);
    expect(report.perfectHits).toBe(1);
    expect(report.missedThrows).toBe(0);
  });
});

describe('Game · 节奏阶段事件', () => {
  it('跨入中盘时只发一次 PhaseChanged', () => {
    const g = new Game(DefaultLevel, new SeededRng(9));
    const transitions: string[] = [];
    g.bus.on('PhaseChanged', ({ from, to }) => transitions.push(`${from}->${to}`));
    const midAt = BalanceConfig.phases.mid.fromSec;
    while (g.elapsed < midAt + 0.05 && !g.over) g.tick(0.05);
    expect(transitions.filter((x) => x === 'early->mid')).toHaveLength(1);
  });

  it('危险区停止生成新的精英/抱团任务，避免无解叠压', () => {
    const dangerLevel: LevelDef = {
      ...DefaultLevel,
      durationSec: 20,
      approvalInit: 75,
      idleCardRatio: 0,
      taskModifiers: {
        eliteRatio: { early: 1, mid: 1, crisis: 1 },
        linkRatio: { early: 1, mid: 1, crisis: 1 },
        eliteMinWeight: 0,
        maxElite: 6,
      },
    };
    const g = new Game(dangerLevel, new SeededRng(12));
    while (g.conveyor.size < 2 && g.elapsed < 5 && !g.over) g.tick(0.05);
    expect(g.conveyor.size).toBeGreaterThan(0);
    expect(g.conveyor.threatCards.every((card) => !card.elite && card.linkId === undefined)).toBe(true);
  });

  it('下一格会直接失败时只预警一次，脱离危险区后才重新武装', () => {
    const dangerLevel: LevelDef = { ...DefaultLevel, approvalInit: 92, durationSec: 20 };
    const g = new Game(dangerLevel, new SeededRng(21));
    const warnings: Array<{ impact: number; boss: boolean; cardIds: number[] }> = [];
    g.bus.on('LastChanceWarning', ({ impact, boss, cardIds }) => warnings.push({ impact, boss, cardIds }));
    g.conveyor.cards[0] = {
      id: 901, category: 'urgent', state: 'active-white', weight: 10, isThreat: true,
    };
    g.tick(0.01);
    g.tick(0.01);
    expect(warnings).toEqual([{ impact: 10, boss: false, cardIds: [901] }]);
    expect(g.getSnapshot().lastChanceImminent).toBe(true);

    g.conveyor.cards[0] = {
      id: 902, category: 'urgent', state: 'rework', weight: 10, isThreat: false,
    };
    g.tick(0.01);
    expect(g.getSnapshot().lastChanceImminent).toBe(false);
    g.conveyor.cards[0] = {
      id: 903, category: 'urgent', state: 'active-white', weight: 10, isThreat: true,
    };
    g.tick(0.01);
    expect(warnings).toHaveLength(1);
  });

  it('Boss 最后机会按真实抽查上限标出临检卡和最高风险任务', () => {
    const bossLevel: LevelDef = {
      ...DefaultLevel,
      approvalInit: 85,
      durationSec: 20,
      boss: { enabled: true, minSpawnSec: 0, inspectionLimit: 2, patternLabel: '重点抽查2张' },
    };
    const g = new Game(bossLevel, new SeededRng(22));
    g.conveyor.cards[0] = { id: 910, category: 'boss', state: 'boss', weight: 0, isThreat: false };
    g.conveyor.cards[1] = { id: 911, category: 'key', state: 'active-white', weight: 5, isThreat: true };
    g.conveyor.cards[2] = { id: 912, category: 'urgent', state: 'active-white', weight: 10, isThreat: true };
    g.conveyor.cards[3] = { id: 913, category: 'proposal', state: 'active-white', weight: 7, isThreat: true };
    let warning: { impact: number; boss: boolean; cardIds: number[] } | null = null;
    g.bus.on('LastChanceWarning', ({ impact, boss, cardIds }) => { warning = { impact, boss, cardIds }; });
    g.tick(0.01);
    expect(warning).toEqual({ impact: 17, boss: true, cardIds: [910, 912, 913] });
  });
});

describe('Game · Boss 固定节拍', () => {
  it('到达编排秒数后生成一次，清除后不会随机补刷', () => {
    const scheduledLevel: LevelDef = {
      ...DefaultLevel,
      durationSec: 20,
      boss: { enabled: true, minSpawnSec: 0, scheduleSec: [2], patternLabel: '单次测试临检' },
    };
    const g = new Game(scheduledLevel, new SeededRng(77));
    let spawned = 0;
    g.bus.on('BossSpawned', () => spawned++);
    expect(g.getSnapshot().nextBossInSec).toBe(2);
    while (g.elapsed < 4 && !g.over) g.tick(0.05);
    expect(spawned).toBe(1);
    expect(g.conveyor.hasBoss()).toBe(true);
    expect(g.getSnapshot().nextBossInSec).toBeNull();
    g.conveyor.clearBoss();
    while (g.elapsed < 15 && !g.over) g.tick(0.05);
    expect(spawned).toBe(1);
  });

  it('固定节拍在入场前 6 秒和 3 秒各预警一次', () => {
    const scheduledLevel: LevelDef = {
      ...DefaultLevel,
      durationSec: 20,
      boss: { enabled: true, minSpawnSec: 0, scheduleSec: [7], patternLabel: '预警测试' },
    };
    const g = new Game(scheduledLevel, new SeededRng(17));
    const warnings: number[] = [];
    g.bus.on('BossBeatWarning', ({ seconds }) => warnings.push(seconds));
    while (g.elapsed < 4.2 && !g.over) g.tick(0.05);
    expect(warnings).toEqual([6, 3]);
  });

  it('重点抽查只结算最高风险任务，未抽中的任务继续留在队列', () => {
    const auditLevel: LevelDef = {
      ...DefaultLevel,
      idleCardRatio: 0,
      boss: { enabled: true, minSpawnSec: 0, inspectionLimit: 2, patternLabel: '重点抽查2张' },
    };
    const g = new Game(auditLevel, new SeededRng(31));
    g.conveyor.generate('early', { forceBoss: true });
    for (let i = 0; i < auditLevel.slots - 1; i++) {
      g.conveyor.step();
      g.conveyor.generate('early');
    }
    const before = g.conveyor.threatCards.map((card) => card.weight);
    const resolved: Array<{ checked: number; remaining: number; riskAdded: number }> = [];
    g.bus.on('BossInspectionResolved', ({ checked, remaining, riskAdded }) => resolved.push({ checked, remaining, riskAdded }));

    g.conveyor.step();

    const expectedRisk = before.slice().sort((a, b) => b - a).slice(0, 2).reduce((sum, weight) => sum + weight, 0);
    expect(resolved).toEqual([{ checked: 2, remaining: before.length - 2, riskAdded: expectedRisk }]);
    expect(g.conveyor.threatCards).toHaveLength(before.length - 2);
  });
});

describe('Game · 即时收益与目标进度', () => {
  it('改需求准确报告风险摆幅，并推进有效命中目标', () => {
    const objectiveLevel: LevelDef = {
      ...DefaultLevel,
      objective: { kind: 'effective-hits', target: 1, label: '命中 1 张任务卡' },
    };
    const g = new Game(objectiveLevel, new SeededRng(5));
    let guard = 0;
    do {
      g.conveyor.reset();
      g.conveyor.generate('early');
    } while (g.conveyor.slotAt(objectiveLevel.slots - 1)?.state !== 'active-white' && guard++ < 20);
    const slot = objectiveLevel.slots - 1;
    const weight = g.conveyor.slotAt(slot)!.weight;
    const effects: Array<{ affected: number; riskPrevented: number }> = [];
    let completed = 0;
    g.bus.on('PropEffectResolved', ({ affected, riskPrevented }) => effects.push({ affected, riskPrevented }));
    g.bus.on('ObjectiveCompleted', () => completed++);
    expect(g.beginCharge(PT.ChangeDemand)).toBe(true);
    expect(g.releaseAtSlot(PT.ChangeDemand, slot, HQ.Normal)).toBe(true);
    expect(effects).toEqual([{ affected: 1, riskPrevented: weight * 2 }]);
    expect(g.getObjectiveSnapshot()).toMatchObject({ current: 1, target: 1, complete: true });
    expect(completed).toBe(1);
  });
});

describe('Game · 队列风险预估与最佳目标', () => {
  const threat = (id: number, weight: number): import('../assets/scripts/core/types').Card => ({
    id,
    category: weight >= 10 ? 'urgent' : weight >= 7 ? 'proposal' : 'key',
    state: 'active-white',
    weight,
    isThreat: true,
  });

  it('三步预估包含白卡上升与返工卡回落，并推荐最高风险改需求目标', () => {
    const g = new Game(DefaultLevel, new SeededRng(9));
    g.conveyor.cards[0] = threat(101, 5);
    g.conveyor.cards[1] = { ...threat(102, 4), state: 'rework', isThreat: false };
    g.conveyor.cards[2] = threat(103, 10);

    expect(g.getThreatForecast(3)).toMatchObject({ delta: 11, projectedApproval: 51, bossInSteps: false, label: '3步 +11' });
    expect(g.getTargetRecommendation(PT.ChangeDemand)).toEqual({
      slot: 2,
      benefit: 20,
      affected: 1,
      label: '风险摆幅 -20',
    });
  });

  it('Boss 进入预测窗口时按抽查上限计算，并让甩锅优先覆盖临检卡', () => {
    const auditLevel: LevelDef = {
      ...DefaultLevel,
      boss: { enabled: true, minSpawnSec: 0, inspectionLimit: 2, patternLabel: '重点抽查2张' },
    };
    const g = new Game(auditLevel, new SeededRng(11));
    g.conveyor.cards[0] = threat(201, 2);
    g.conveyor.cards[1] = { id: 202, category: 'boss', state: 'boss', weight: 0, isThreat: false };
    g.conveyor.cards[2] = threat(203, 10);
    g.conveyor.cards[3] = threat(204, 7);
    g.conveyor.cards[4] = threat(205, 5);

    expect(g.getThreatForecast(3)).toMatchObject({ delta: 19, bossInSteps: true, label: '临检预计 +19' });
    expect(g.getTargetRecommendation(PT.ThrowPot)).toMatchObject({ slot: 2, label: expect.stringContaining('拦截临检') });
  });

  it('改需求优先推荐可直接返工的高收益目标，而不是只看精英表面权重', () => {
    const g = new Game(DefaultLevel, new SeededRng(15));
    g.conveyor.cards[2] = { ...threat(301, 10), elite: true, guard: 1, baseWeight: 10 };
    g.conveyor.cards[3] = threat(302, 7);
    expect(g.getTargetRecommendation(PT.ChangeDemand)).toEqual({
      slot: 3,
      benefit: 14,
      affected: 1,
      label: '风险摆幅 -14',
    });
  });
});

describe('Game · 失败原因归因', () => {
  const raiseApprovalTo98 = (g: Game) => g.approval.resolveCard({
    id: -1,
    category: 'urgent',
    state: 'active-white',
    weight: 58,
    isThreat: true,
  });

  it('普通任务进入处理区导致满值时记为未处理任务', () => {
    const g = new Game(DefaultLevel, new SeededRng(5));
    let guard = 0;
    do {
      g.conveyor.reset();
      g.conveyor.generate('early');
    } while (g.conveyor.slotAt(DefaultLevel.slots - 1)?.state !== 'active-white' && guard++ < 20);
    for (let i = 0; i < DefaultLevel.slots - 1; i++) g.conveyor.step();
    raiseApprovalTo98(g);
    g.conveyor.step();
    expect(g.result).toBe('lose');
    expect(g.lastFailReason).toBe('unhandled-task');
    expect(g.getFailureCoach()).toMatchObject({ reason: 'unhandled-task', impact: expect.any(Number), affected: 1 });
    expect(g.getFailureCoach().title).toContain('任务漏进处理区');
  });

  it('Boss 临检结算导致满值时记为临检', () => {
    const g = new Game(DefaultLevel, new SeededRng(5));
    g.conveyor.generate('early', { forceBoss: true });
    for (let i = 0; i < DefaultLevel.slots - 1; i++) {
      g.conveyor.step();
      g.conveyor.generate('early');
    }
    expect(g.conveyor.threatCards.length).toBeGreaterThan(0);
    raiseApprovalTo98(g);
    g.conveyor.step();
    expect(g.result).toBe('lose');
    expect(g.lastFailReason).toBe('boss-inspection');
    expect(g.getFailureCoach()).toMatchObject({ reason: 'boss-inspection', affected: expect.any(Number) });
    expect(g.getFailureCoach().title).toContain('临检一次结算');
  });
});

describe('LevelSystem · 星级评价（§6.2）', () => {
  const lvl = new LevelSystem(BalanceConfig, DefaultLevel);

  it('失败 → 0 星', () => {
    expect(lvl.starRating('lose', { peakApproval: 100, timeUsedSec: 60, bossInspectionsFired: 1 })).toBe(0);
  });

  it('生存通关、峰值<70、但让 Boss 临检过 → 2 星', () => {
    expect(lvl.starRating('win-survive', { peakApproval: 65, timeUsedSec: 60, bossInspectionsFired: 1 })).toBe(2);
  });

  it('生存通关、全程未让 Boss 临检生效 → 3 星', () => {
    expect(lvl.starRating('win-survive', { peakApproval: 65, timeUsedSec: 60, bossInspectionsFired: 0 })).toBe(3);
  });

  it('猎杀式通关且用时<40s → 3 星', () => {
    expect(lvl.starRating('win-hunt', { peakApproval: 40, timeUsedSec: 35, bossInspectionsFired: 0 })).toBe(3);
  });

  it('生存通关但进过危险区(峰值≥70) → 1 星', () => {
    expect(lvl.starRating('win-survive', { peakApproval: 80, timeUsedSec: 60, bossInspectionsFired: 1 })).toBe(1);
  });
});
