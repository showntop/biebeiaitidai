export type RewardPlacement = 'revive' | 'result-double' | 'challenge-extra';

export interface CommercialConfig {
  /** 灰度总开关。仓库默认 false，未配置广告位时永远不能展示。 */
  enabled: boolean;
  rewardedAdUnitId: string;
  enabledPlacements: RewardPlacement[];
  sessionCap: number;
  cooldownSec: number;
}

export const DefaultCommercialConfig: CommercialConfig = {
  enabled: false,
  rewardedAdUnitId: '',
  enabledPlacements: ['revive'],
  sessionCap: 3,
  cooldownSec: 90,
};

export interface CommercialContext {
  voluntary: boolean;
  nowMs: number;
}

/** 纯策略层：只判断是否允许“主动激励视频”，项目不存在插屏入口。 */
export class MonetizationPolicy {
  private shown = 0;
  private lastShownAt = -Infinity;

  constructor(readonly config: CommercialConfig) {}

  canOffer(placement: RewardPlacement, context: CommercialContext): boolean {
    if (!this.config.enabled || !context.voluntary) return false;
    if (!this.config.rewardedAdUnitId.trim()) return false;
    if (!this.config.enabledPlacements.includes(placement)) return false;
    if (this.shown >= Math.max(0, this.config.sessionCap)) return false;
    return context.nowMs - this.lastShownAt >= Math.max(0, this.config.cooldownSec) * 1000;
  }

  recordShown(nowMs: number): void {
    this.shown++;
    this.lastShownAt = nowMs;
  }

  get sessionShown(): number {
    return this.shown;
  }
}

export function validateCommercialConfig(config: CommercialConfig): string[] {
  const errors: string[] = [];
  if (config.enabled && !config.rewardedAdUnitId.trim()) errors.push('enabled commercial config requires rewardedAdUnitId');
  if (config.sessionCap < 0 || !Number.isFinite(config.sessionCap)) errors.push('sessionCap must be a non-negative number');
  if (config.cooldownSec < 0 || !Number.isFinite(config.cooldownSec)) errors.push('cooldownSec must be a non-negative number');
  const allowed: RewardPlacement[] = ['revive', 'result-double', 'challenge-extra'];
  if (config.enabledPlacements.some((placement) => !allowed.includes(placement))) errors.push('unknown rewarded placement');
  return errors;
}
