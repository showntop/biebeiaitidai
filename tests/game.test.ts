import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { LevelSystem } from '../assets/scripts/core/systems/LevelSystem';
import { BalanceConfig, DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';
import type { GameResult } from '../assets/scripts/core/types';

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
