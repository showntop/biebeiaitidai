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
});
