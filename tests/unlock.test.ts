import { describe, it, expect } from 'vitest';
import { Game } from '../assets/scripts/core/Game';
import { getLevel, unlockedPropsUpTo } from '../assets/scripts/core/config';
import { DefaultLevel } from '../assets/scripts/core/config';
import { SeededRng } from '../assets/scripts/core/rng';
import { PropType as PT } from '../assets/scripts/core/types';

/**
 * §1.2 错峰解锁强制验收：
 * - 第1关只解锁加需求/改需求 → 丢锅/拍马屁 canUse=false、beginCharge 拒绝
 * - 第5关解锁丢锅 → 加/改/丢 可用，拍马屁仍锁（§1.2 拍马屁在 11~15 关才解锁）
 * - DefaultLevel（未指定 allowedProps）→ 全4个解锁
 */
describe('§1.2 错峰解锁强制（unlockedProps）', () => {
  it('第1关：丢锅/拍马屁被锁定，加/改需求可用', () => {
    const g = new Game(getLevel(0), new SeededRng(1), unlockedPropsUpTo(0));
    expect(g.prop.isUnlocked(PT.AddDemand)).toBe(true);
    expect(g.prop.isUnlocked(PT.ChangeDemand)).toBe(true);
    expect(g.prop.isUnlocked(PT.ThrowPot)).toBe(false);
    expect(g.prop.isUnlocked(PT.KissUp)).toBe(false);

    // 锁定道具 canUse 恒为 false
    expect(g.prop.canUse(PT.ThrowPot)).toBe(false);
    expect(g.prop.canUse(PT.KissUp)).toBe(false);
    // 即便尝试蓄力也被拒
    expect(g.beginCharge(PT.ThrowPot)).toBe(false);
    expect(g.useKissUp()).toBe(false);
    // 解锁的改需求首用可蓄力
    expect(g.beginCharge(PT.ChangeDemand)).toBe(true);
  });

  it('第5关：解锁丢锅，拍马屁仍锁', () => {
    const g = new Game(getLevel(4), new SeededRng(1), unlockedPropsUpTo(4));
    expect(g.prop.isUnlocked(PT.AddDemand)).toBe(true);
    expect(g.prop.isUnlocked(PT.ChangeDemand)).toBe(true);
    expect(g.prop.isUnlocked(PT.ThrowPot)).toBe(true);
    expect(g.prop.isUnlocked(PT.KissUp)).toBe(false); // 11~15关才解锁
  });

  it('DefaultLevel（未传 allowedProps）→ 全4个道具解锁（兼容 sim/原 default 行为）', () => {
    const g = new Game(DefaultLevel, new SeededRng(1));
    expect(g.prop.allowedProps).toHaveLength(4);
    expect(g.prop.isUnlocked(PT.KissUp)).toBe(true);
  });
});
