import { describe, expect, it } from 'vitest';
import {
  DefaultCommercialConfig,
  MonetizationPolicy,
  validateCommercialConfig,
} from '../assets/scripts/core/MonetizationPolicy';
import { RewardedAdBridge } from '../assets/scripts/cocos/RewardedAdBridge';

describe('商业化护栏', () => {
  it('仓库默认关闭，且没有任何插屏 placement', () => {
    expect(DefaultCommercialConfig.enabled).toBe(false);
    expect(DefaultCommercialConfig.rewardedAdUnitId).toBe('');
    expect(DefaultCommercialConfig.enabledPlacements).toEqual(['revive']);
    expect(new MonetizationPolicy(DefaultCommercialConfig).canOffer('revive', { voluntary: true, nowMs: 100000 })).toBe(false);
  });

  it('只允许主动触发、白名单 placement，并执行冷却和单会话上限', () => {
    const policy = new MonetizationPolicy({
      enabled: true,
      rewardedAdUnitId: 'test-ad-unit',
      enabledPlacements: ['revive'],
      sessionCap: 2,
      cooldownSec: 90,
    });
    expect(policy.canOffer('revive', { voluntary: false, nowMs: 100000 })).toBe(false);
    expect(policy.canOffer('result-double', { voluntary: true, nowMs: 100000 })).toBe(false);
    expect(policy.canOffer('revive', { voluntary: true, nowMs: 100000 })).toBe(true);
    policy.recordShown(100000);
    expect(policy.canOffer('revive', { voluntary: true, nowMs: 150000 })).toBe(false);
    expect(policy.canOffer('revive', { voluntary: true, nowMs: 190000 })).toBe(true);
    policy.recordShown(190000);
    expect(policy.canOffer('revive', { voluntary: true, nowMs: 999999 })).toBe(false);
  });

  it('错误灰度配置会被发布前校验拒绝', () => {
    expect(validateCommercialConfig({
      enabled: true,
      rewardedAdUnitId: '',
      enabledPlacements: ['revive'],
      sessionCap: -1,
      cooldownSec: -2,
    })).toEqual(expect.arrayContaining([
      'enabled commercial config requires rewardedAdUnitId',
      'sessionCap must be a non-negative number',
      'cooldownSec must be a non-negative number',
    ]));
  });

  it('广告加载失败不消耗会话次数或冷却，下一次仍可正常完成', async () => {
    const runtime = globalThis as unknown as {
      __BRAATN_COMMERCIAL_CONFIG__?: object;
      wx?: object;
    };
    const previousConfig = runtime.__BRAATN_COMMERCIAL_CONFIG__;
    const previousWx = runtime.wx;
    let attempts = 0;
    runtime.__BRAATN_COMMERCIAL_CONFIG__ = {
      enabled: true,
      rewardedAdUnitId: 'test-ad-unit',
      enabledPlacements: ['revive'],
      sessionCap: 1,
      cooldownSec: 999,
    };
    runtime.wx = {
      createRewardedVideoAd: () => {
        attempts++;
        let close: ((result?: { isEnded?: boolean }) => void) | null = null;
        const currentAttempt = attempts;
        return {
          load: () => currentAttempt === 1 ? Promise.reject(new Error('no fill')) : Promise.resolve(),
          show: async () => { close?.({ isEnded: true }); },
          onClose: (handler: (result?: { isEnded?: boolean }) => void) => { close = handler; },
          offClose: () => { close = null; },
          onError: () => {},
        };
      },
    };

    try {
      const bridge = new RewardedAdBridge();
      await expect(bridge.show('revive')).resolves.toBe('unavailable');
      await expect(bridge.show('revive')).resolves.toBe('completed');
      await expect(bridge.show('revive')).resolves.toBe('unavailable');
      expect(attempts).toBe(2);
    } finally {
      runtime.__BRAATN_COMMERCIAL_CONFIG__ = previousConfig;
      runtime.wx = previousWx;
    }
  });
});
