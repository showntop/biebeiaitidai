import {
  DefaultCommercialConfig,
  MonetizationPolicy,
  validateCommercialConfig,
} from '../core/MonetizationPolicy';
import type { CommercialConfig, RewardPlacement } from '../core/MonetizationPolicy';

export type RewardedOutcome = 'bypassed' | 'completed' | 'skipped' | 'unavailable';

interface RewardedVideoAd {
  load(): Promise<void>;
  show(): Promise<void>;
  onClose(handler: (result?: { isEnded?: boolean }) => void): void;
  offClose?(handler: (result?: { isEnded?: boolean }) => void): void;
  onError?(handler: (error: unknown) => void): void;
}

interface WechatAdApi {
  createRewardedVideoAd(options: { adUnitId: string; multiton?: boolean }): RewardedVideoAd;
}

/**
 * 激励视频薄适配。仓库默认关闭；关闭时返回 bypassed，现有免费复活保持不变。
 * 只有显式灰度配置 + 合法广告位 + 玩家主动点击时才会请求平台广告。
 */
export class RewardedAdBridge {
  readonly config: CommercialConfig;
  private readonly policy: MonetizationPolicy;
  private pending = false;

  constructor() {
    const injected = (globalThis as unknown as { __BRAATN_COMMERCIAL_CONFIG__?: Partial<CommercialConfig> }).__BRAATN_COMMERCIAL_CONFIG__;
    this.config = { ...DefaultCommercialConfig, ...(injected ?? {}) };
    if (validateCommercialConfig(this.config).length > 0) this.config.enabled = false;
    this.policy = new MonetizationPolicy(this.config);
  }

  async show(placement: RewardPlacement): Promise<RewardedOutcome> {
    if (!this.config.enabled) return 'bypassed';
    if (this.pending) return 'unavailable';
    const now = Date.now();
    if (!this.policy.canOffer(placement, { voluntary: true, nowMs: now })) return 'unavailable';
    const wxApi = (globalThis as unknown as { wx?: WechatAdApi }).wx;
    if (!wxApi?.createRewardedVideoAd) return 'unavailable';
    this.pending = true;
    try {
      const ad = wxApi.createRewardedVideoAd({ adUnitId: this.config.rewardedAdUnitId, multiton: true });
      return await new Promise<RewardedOutcome>((resolve) => {
        let settled = false;
        let exposureRecorded = false;
        const recordExposure = () => {
          if (exposureRecorded) return;
          exposureRecorded = true;
          this.policy.recordShown(Date.now());
        };
        const close = (result?: { isEnded?: boolean }) => {
          if (settled) return;
          // 收到关闭回调说明广告确实展示过；加载/展示失败不应消耗冷却和次数。
          recordExposure();
          settled = true;
          ad.offClose?.(close);
          resolve(result?.isEnded === false ? 'skipped' : 'completed');
        };
        ad.onClose(close);
        ad.onError?.(() => {
          if (!settled) {
            settled = true;
            ad.offClose?.(close);
            resolve('unavailable');
          }
        });
        void (async () => {
          try {
            await ad.load();
            await ad.show();
            recordExposure();
          } catch {
            if (!settled) {
              settled = true;
              ad.offClose?.(close);
              resolve('unavailable');
            }
          }
        })();
      });
    } catch {
      return 'unavailable';
    } finally {
      this.pending = false;
    }
  }
}
