import { describe, expect, it } from 'vitest';
import { parseQaLaunchConfig } from '../assets/scripts/core/QaLaunchConfig';

describe('QA 启动参数', () => {
  it('没有合法 qa 场景时保持正式启动流程', () => {
    expect(parseQaLaunchConfig('')).toBeNull();
    expect(parseQaLaunchConfig('?qa=unknown')).toBeNull();
  });

  it('解析固定种子和 1-based 关卡', () => {
    expect(parseQaLaunchConfig('?qa=perfect&seed=20260717&level=3')).toEqual({
      scenario: 'perfect',
      seed: 20260717,
      levelIndex: 2,
    });
  });

  it('缺省值稳定且关卡会钳位', () => {
    expect(parseQaLaunchConfig('?qa=playing&level=999', 20)).toEqual({
      scenario: 'playing',
      seed: 424242,
      levelIndex: 19,
    });
    expect(parseQaLaunchConfig('?qa=entry&seed=bad&level=-2', 20)).toEqual({
      scenario: 'entry',
      seed: 424242,
      levelIndex: 0,
    });
  });

  it('支持无问号查询串和 URL 编码', () => {
    expect(parseQaLaunchConfig('qa=result-hunt&seed=7&level=2')).toEqual({
      scenario: 'result-hunt',
      seed: 7,
      levelIndex: 1,
    });
  });

  it('支持暂停菜单的固定视觉验收场景', () => {
    expect(parseQaLaunchConfig('?qa=pause&level=4')).toMatchObject({
      scenario: 'pause',
      levelIndex: 3,
    });
  });

  it('支持范围预览和临检预警视觉场景', () => {
    expect(parseQaLaunchConfig('?qa=blast&level=10')?.scenario).toBe('blast');
    expect(parseQaLaunchConfig('?qa=boss-warning&level=10')?.scenario).toBe('boss-warning');
    expect(parseQaLaunchConfig('?qa=boss-critical&level=18')?.scenario).toBe('boss-critical');
  });

  it('支持连击奖励和连续 Perfect 演出场景', () => {
    expect(parseQaLaunchConfig('?qa=combo-reward&level=17')?.scenario).toBe('combo-reward');
    expect(parseQaLaunchConfig('?qa=perfect-chain&level=18')?.scenario).toBe('perfect-chain');
    expect(parseQaLaunchConfig('?qa=elite-link&level=18')?.scenario).toBe('elite-link');
    expect(parseQaLaunchConfig('?qa=shield-break&level=18')?.scenario).toBe('shield-break');
    expect(parseQaLaunchConfig('?qa=rework-hit&level=1')?.scenario).toBe('rework-hit');
    expect(parseQaLaunchConfig('?qa=last-chance&level=18')?.scenario).toBe('last-chance');
  });

  it('支持关卡路线和成就收藏视觉验收场景', () => {
    expect(parseQaLaunchConfig('?qa=career-route&level=8')?.scenario).toBe('career-route');
    expect(parseQaLaunchConfig('?qa=career-achievements')?.scenario).toBe('career-achievements');
    expect(parseQaLaunchConfig('?qa=result-daily&level=6')?.scenario).toBe('result-daily');
    expect(parseQaLaunchConfig('?qa=result-rankup')?.scenario).toBe('result-rankup');
  });

  it('支持前3关教学提示视觉验收场景', () => {
    expect(parseQaLaunchConfig('?qa=onboarding-perfect&level=2')?.scenario).toBe('onboarding-perfect');
    expect(parseQaLaunchConfig('?qa=onboarding-hunt&level=3')?.scenario).toBe('onboarding-hunt');
  });
});
