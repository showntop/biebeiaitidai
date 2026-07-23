import { describe, expect, it } from 'vitest';
import {
  boundedThrowPeakY,
  findLockedCardSlot,
  guidedThrowLeadPoint,
  isManualThrowGesture,
  projectedThrowTargetX,
  throwPresentationStrength,
} from '../assets/scripts/core/ThrowGesture';

describe('投掷手势', () => {
  it('轻点不进入手动选位，超过死区才切换目标', () => {
    expect(isManualThrowGesture(8, 6)).toBe(false);
    expect(isManualThrowGesture(18, 1)).toBe(true);
  });

  it('按拖动朝向投影到任务横排，轻微上移不会无限放大', () => {
    expect(projectedThrowTargetX(-100, -400, 0, -200, 200)).toBe(140);
    expect(projectedThrowTargetX(-100, -400, 40, -395, 200)).toBe(40);
    expect(projectedThrowTargetX(-100, -400, -100, -100, 200)).toBe(-100);
  });

  it('投掷最高点不越过屏顶安全边界', () => {
    expect(boundedThrowPeakY(-400, 260, 360, 175)).toBe(332);
    expect(boundedThrowPeakY(-400, 120, 360, 32)).toBe(152);
    expect(boundedThrowPeakY(-400, 350, 360, 80)).toBe(350);
  });

  it('引导投掷前段保留玩家的甩出方向，慢速时则稳定朝目标', () => {
    const flick = guidedThrowLeadPoint({ x: 0, y: 0 }, { x: 200, y: 400 }, { x: -600, y: 900 }, true);
    expect(flick.x).toBeLessThan(0);
    expect(flick.y).toBeGreaterThan(0);
    const tap = guidedThrowLeadPoint({ x: 0, y: 0 }, { x: 200, y: 400 }, { x: 0, y: 0 }, false);
    expect(tap.x).toBeGreaterThan(0);
    expect(tap.y).toBeGreaterThan(0);
  });

  it('甩速只映射到 0~1 演出强度', () => {
    expect(throwPresentationStrength(200)).toBe(0);
    expect(throwPresentationStrength(260)).toBe(0);
    expect(throwPresentationStrength(680)).toBeCloseTo(0.5);
    expect(throwPresentationStrength(1800)).toBe(1);
  });

  it('按卡片 ID 跟随移动，离场后不悄悄改锁别的卡', () => {
    const moved = [{ id: 7 }, null, { id: 3 }];
    expect(findLockedCardSlot(moved, 3)).toBe(2);
    expect(findLockedCardSlot(moved, 99)).toBe(-1);
    expect(findLockedCardSlot(moved, null)).toBe(-1);
  });
});
