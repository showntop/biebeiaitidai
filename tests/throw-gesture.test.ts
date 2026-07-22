import { describe, expect, it } from 'vitest';
import {
  findLockedCardSlot,
  isHorizontalTargetGesture,
  isManualThrowGesture,
  isThrowCancelGesture,
  throwPresentationStrength,
} from '../assets/scripts/core/ThrowGesture';

describe('投掷手势', () => {
  it('轻点不进入手动选位，超过死区才切换目标', () => {
    expect(isManualThrowGesture(8, 6)).toBe(false);
    expect(isManualThrowGesture(18, 1)).toBe(true);
  });

  it('向上甩的横向漂移不抢目标，明确横扫才进入选位', () => {
    expect(isHorizontalTargetGesture(22, 80)).toBe(false);
    expect(isHorizontalTargetGesture(30, 20)).toBe(true);
    expect(isHorizontalTargetGesture(-30, 20)).toBe(true);
    expect(isHorizontalTargetGesture(17, 0)).toBe(false);
  });

  it('向下回拉取消，普通松手和向上甩都不会取消', () => {
    expect(isThrowCancelGesture(-53)).toBe(false);
    expect(isThrowCancelGesture(-54)).toBe(true);
    expect(isThrowCancelGesture(120)).toBe(false);
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
