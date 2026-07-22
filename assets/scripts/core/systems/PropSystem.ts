import type { EventBus } from '../EventBus';
import type { BalanceConfigT } from '../config';
import { PropsConfig } from '../config';
import type { PropDef } from '../config';
import type { BeltView, GamePhase, HitQuality, PerfectRewardType, PropType } from '../types';
import { PropType as PT, HitQuality as HQ } from '../types';
import type { Rng } from '../rng';

interface PropRuntime {
  cdRemaining: number; // cd 类：当前剩余冷却秒
  uses: number; // 总量上限剩余次数
  energy: number; // 能量槏类：[0..1]
}

/**
 * 道具系统（核心规则层，对应策划文档§4）。
 *
 * 4 纸团：白纸团(插入)/紫纸团(倒扣)/咖啡纸团(范围清空) 走"长按蓄力+划扔"瞄准；
 * 拍马屁(冻结) 点按即放、不走扫描。
 *
 * 关键设计落点：
 *  - §4.1 常驻CD + 能量槏混合制，位置固定（肌肉记忆）。
 *  - §4.3 离散挡位瞄准：松手即命中当前高亮挡位的卡；Perfect 命中走可变奖励池。
 *  - §4.3-3 扫满后：有效目标则保持(不强制开火)，空挡/无效才自动脱手。
 *  - §4.3-4 取消手势不消耗次数。
 *  - §4.4 连击跨阶段时返还当前纸团少量冷却；Perfect 奖励仍独立结算。
 *  - §5.4② Boss 资源保底：Boss 生成时若丢锅/拍马屁能量均<阈值，把丢锅充至保证值。
 *
 * 只读 BeltView 判定目标有效性；命中后发 CardHit 事件，由 ConveyorSystem 执行插入/污染/清空。
 */
export class PropSystem {
  private rt: Record<PropType, PropRuntime>;
  private charging: PropType | null = null;
  private scan = 0; // 蓄力扫描进度 [0..1]
  private combo = 0;
  private perfectChain = 0;
  private lastHit = -Infinity;
  private clock = 0;
  private phase: GamePhase = 'early';
  /** §1.2 本关已解锁的道具集合（错峰解锁）。未解锁的道具 canUse 恒为 false。 */
  private allowed: Set<PropType>;

  constructor(
    private cfg: BalanceConfigT,
    private events: EventBus,
    private rng: Rng,
    private belt: BeltView,
    private slots: number,
    allowedProps?: readonly PropType[],
  ) {
    this.rt = {
      [PT.AddDemand]: this.freshRuntime(PT.AddDemand),
      [PT.ChangeDemand]: this.freshRuntime(PT.ChangeDemand),
      [PT.ThrowPot]: this.freshRuntime(PT.ThrowPot),
      [PT.KissUp]: this.freshRuntime(PT.KissUp),
    };
    this.allowed = new Set(allowedProps ?? ALL_PROPS);
  }

  private freshRuntime(prop: PropType): PropRuntime {
    const def = PropsConfig[prop];
    return { cdRemaining: 0, uses: def.totalCap, energy: 0 };
  }

  /** 每帧推进：CD 计时、拍马屁被动回槏、蓄力扫描。phase 由 Game 传入。 */
  tick(dt: number, phase: GamePhase): void {
    this.phase = phase;
    this.clock += dt;

    for (const prop of [PT.AddDemand, PT.ChangeDemand] as PropType[]) {
      if (this.rt[prop].cdRemaining > 0) {
        this.rt[prop].cdRemaining = Math.max(0, this.rt[prop].cdRemaining - dt);
      }
    }
    const ku = PropsConfig[PT.KissUp];
    if (ku.energyPerSec) {
      this.rt[PT.KissUp].energy = Math.min(1, this.rt[PT.KissUp].energy + ku.energyPerSec * dt);
    }

    if (this.charging) {
      this.scan += dt / this.cfg.control.scanSec;
      if (this.scan >= 1) {
        this.scan = 1;
        // §4.3-3 扫满：当前(最远)挡位是有效目标则保持等松手；空挡/无效才自动脱手
        const far = this.slots - 1;
        if (!this.targetValid(this.charging, far)) {
          this.resolve(this.charging, far, HQ.Normal);
        }
      }
    }
  }

  /** 开始蓄力（加需求/改需求/丢锅）。拍马屁用 useKissUp。不可用时返回 false。 */
  beginCharge(prop: PropType): boolean {
    if (prop === PT.KissUp) return false;
    if (!this.canUse(prop)) return false;
    this.charging = prop;
    this.scan = 0;
    return true;
  }

  /** 松手：按当前扫描进度判定挡位与 Perfect，结算。 */
  release(prop: PropType): boolean {
    if (this.charging !== prop) return false;
    const slot = this.slotFromScan();
    const quality = this.perfectAt(slot) ? HQ.Perfect : HQ.Normal;
    this.resolve(prop, slot, quality);
    return true;
  }

  /** Cocos 投纸团输入：表现层根据落点算出槽位，规则层仍复用同一套命中结算。 */
  releaseAtSlot(prop: PropType, slot: number, quality: HitQuality = HQ.Normal): boolean {
    if (this.charging !== prop) return false;
    const clamped = Math.max(0, Math.min(this.slots - 1, Math.floor(slot)));
    this.resolve(prop, clamped, quality);
    return true;
  }

  /** §4.3-4 取消：不消耗次数、不冷却。 */
  cancel(prop: PropType): void {
    if (this.charging !== prop) return;
    this.events.emit('PropCanceled', { prop });
    this.endCharge();
  }

  /** 系统暂停/切后台时静默终止蓄力：不消耗、不冷却，也不记为玩家取消。 */
  suspendCharge(): void {
    if (this.charging === null) return;
    this.endCharge();
  }

  /** 拍马屁：点按即放、无需瞄准、无 Perfect。命中AI本体→请求冻结。 */
  useKissUp(): boolean {
    if (!this.canUse(PT.KissUp)) return false;
    this.rt[PT.KissUp].uses--;
    this.rt[PT.KissUp].energy = 0;
    this.events.emit('AIHit', { quality: HQ.Normal });
    const f = PropsConfig[PT.KissUp].freezeSec!;
    const durationSec = f.min + (f.max - f.min) * this.rng.next();
    this.events.emit('KissUpFreeze', { durationSec });
    return true;
  }

  /** §5.4② Boss 资源保底：Boss 生成时，丢锅能量<阈值 → 把丢锅充至保证值（不看拍马屁）。
   *  原条件"丢锅 AND 拍马屁均<阈值"与拍马屁被动回充(0.02/s≈25s达0.5)冲突，
   *  导致条件几乎不满足、保底形同虚设。丢锅才是真正能炸掉Boss卡的手段，故只看丢锅。
   *  totalCap=2一般够用，不另做uses保底。触发时主动发BossGuaranteeTriggered供UI/M4验收监听。 */
  onBossSpawned(): void {
    if (this.rt[PT.ThrowPot].energy < this.cfg.boss.guaranteeEnergyThreshold) {
      this.rt[PT.ThrowPot].energy = Math.max(this.rt[PT.ThrowPot].energy, this.cfg.boss.guaranteeFillTo);
      this.events.emit('BossGuaranteeTriggered', { filledTo: this.cfg.boss.guaranteeFillTo });
    }
  }

  /* ---------- 状态查询（供表现层/UI） ---------- */

  /** §1.2 本关是否解锁该道具（错峰解锁）。 */
  isUnlocked(prop: PropType): boolean {
    return this.allowed.has(prop);
  }

  /** 本关已解锁道具（供 UI 置灰锁定按钮）。 */
  get allowedProps(): PropType[] {
    return Array.from(this.allowed);
  }

  canUse(prop: PropType): boolean {
    if (!this.allowed.has(prop)) return false; // §1.2 未解锁不可用
    const r = this.rt[prop];
    const def = PropsConfig[prop];
    if (def.acquisition === 'cd') return r.cdRemaining <= 0 && r.uses > 0;
    return r.energy >= 1 && r.uses > 0;
  }

  getState(prop: PropType): { acquisition: string; cdRemaining: number; uses: number; energy: number; ready: boolean } {
    const r = this.rt[prop];
    return {
      acquisition: PropsConfig[prop].acquisition,
      cdRemaining: r.cdRemaining,
      uses: r.uses,
      energy: r.energy,
      ready: this.canUse(prop),
    };
  }

  get currentCombo(): number {
    return this.combo;
  }

  /** 当前正在蓄力的道具（表现层高亮瞄准用）。 */
  get chargingProp(): PropType | null {
    return this.charging;
  }

  /** 当前扫描高亮的挡位（-1 表示未蓄力）。 */
  get scanSlot(): number {
    return this.charging ? this.slotFromScan() : -1;
  }

  /* ---------- 内部 ---------- */

  private resolve(prop: PropType, slot: number, quality: HitQuality): void {
    if (!this.targetValid(prop, slot)) {
      const reason: 'empty' | 'invalid-target' = prop === PT.ChangeDemand ? 'invalid-target' : 'empty';
      this.events.emit('PropUnavailable', { prop, slot, reason });
      if (reason === 'empty') {
        // §4.4 落空 Miss 清零连击
        this.combo = 0;
        this.events.emit('ComboUpdated', { combo: 0 });
      }
      this.breakPerfectChain();
      this.endCharge();
      return;
    }

    // 消耗
    this.rt[prop].uses--;
    const def = PropsConfig[prop];
    if (def.acquisition === 'cd') {
      this.rt[prop].cdRemaining = this.cdForPhase(prop);
    } else if (prop === PT.ThrowPot) {
      this.rt[PT.ThrowPot].energy = 0; // 丢锅用后清零重新攒
    }

    // Perfect 可变奖励
    if (quality === HQ.Perfect) {
      const reward = this.applyPerfectReward(prop);
      this.events.emit('PerfectRewardGranted', { prop, reward });
    }

    if (quality === HQ.Perfect) {
      this.perfectChain++;
      this.events.emit('PerfectChainUpdated', { chain: this.perfectChain });
    } else {
      this.breakPerfectChain();
    }

    this.events.emit('CardHit', { prop, slot, quality, card: this.belt.slotAt(slot) ?? undefined });

    // 有效命中：加需求/改需求 回充丢锅能量 + 连击；丢锅自身不回充
    if (prop === PT.AddDemand || prop === PT.ChangeDemand) {
      const per = PropsConfig[PT.ThrowPot].energyPerEffectiveHit ?? 0;
      this.rt[PT.ThrowPot].energy = Math.min(1, this.rt[PT.ThrowPot].energy + per);
      if (this.clock - this.lastHit <= this.cfg.combo.windowSec) this.combo++;
      else this.combo = 1;
      this.lastHit = this.clock;
      this.events.emit('ComboUpdated', { combo: this.combo });
      this.applyComboReward(prop);
    }

    this.endCharge();
  }

  /** 目标有效性（读 BeltView，不持有 ConveyorSystem 引用）。 */
  private targetValid(prop: PropType, slot: number): boolean {
    if (prop === PT.AddDemand) return true; // 插队键，随手可用
    if (prop === PT.ChangeDemand) {
      const c = this.belt.slotAt(slot);
      return !!c && c.state === 'active-white';
    }
    if (prop === PT.ThrowPot) {
      const radius = PropsConfig[PT.ThrowPot].clearRadius ?? 1;
      return (this.belt as ConveyorLike).hasCardsInRange(slot, radius);
    }
    return false;
  }

  private slotFromScan(): number {
    const s = Math.floor(this.scan * this.slots);
    return s < 0 ? 0 : s >= this.slots ? this.slots - 1 : s;
  }

  private perfectAt(slot: number): boolean {
    const span = 1 / this.slots;
    const center = (slot + 0.5) * span;
    const half = (span * this.cfg.control.perfectWindowRatio) / 2;
    return Math.abs(this.scan - center) <= half;
  }

  private applyPerfectReward(prop: PropType): PerfectRewardType {
    const table = PropsConfig.perfectRewards;
    const r = this.rng.next();
    let acc = 0;
    let chosen = table[table.length - 1];
    for (const t of table) {
      acc += t.p;
      if (r < acc) {
        chosen = t;
        break;
      }
    }
    const def: PropDef = PropsConfig[prop];
    switch (chosen.type) {
      case 'cd-refill-10':
        if (def.acquisition === 'cd') {
          this.rt[prop].cdRemaining = Math.max(0, this.rt[prop].cdRemaining - 0.1 * this.cdForPhase(prop));
        } else {
          this.rt[prop].energy = Math.min(1, this.rt[prop].energy + 0.1);
        }
        return chosen.type;
      case 'extra-use':
        this.rt[prop].uses++; // 突破单局上限
        return chosen.type;
      case 'energy-full':
        if (def.acquisition === 'energy') this.rt[prop].energy = 1;
        else this.rt[prop].cdRemaining = 0;
        return chosen.type;
    }
  }

  private cdForPhase(prop: PropType): number {
    const cd = PropsConfig[prop].cd!;
    return cd[this.phase];
  }

  /** 连击阶段奖励只返还当前出手道具的少量冷却，不改变任务风险数值。 */
  private applyComboReward(prop: PropType): void {
    const rewardIndex = this.cfg.combo.rewards.findIndex((reward) => reward.combo === this.combo);
    if (rewardIndex < 0) return;
    const reward = this.cfg.combo.rewards[rewardIndex];
    const runtime = this.rt[prop];
    const before = runtime.cdRemaining;
    runtime.cdRemaining = Math.max(0, before - reward.cooldownReducedSec);
    const actual = before - runtime.cdRemaining;
    this.events.emit('ComboRewardGranted', {
      combo: this.combo,
      tier: Math.min(3, rewardIndex + 1) as 1 | 2 | 3,
      label: reward.label,
      cooldownReducedSec: actual,
    });
  }

  private breakPerfectChain(): void {
    if (this.perfectChain <= 0) return;
    this.perfectChain = 0;
    this.events.emit('PerfectChainUpdated', { chain: 0 });
  }

  private endCharge(): void {
    this.charging = null;
    this.scan = 0;
  }
}

/** ConveyorSystem 暴露的范围查询（targetValid 用于丢锅判定） */
interface ConveyorLike extends BeltView {
  hasCardsInRange(slot: number, radius: number): boolean;
}

/** 全部道具（未指定解锁集合时的默认值，如 DefaultLevel / sim）。 */
const ALL_PROPS: PropType[] = [PT.AddDemand, PT.ChangeDemand, PT.ThrowPot, PT.KissUp];
