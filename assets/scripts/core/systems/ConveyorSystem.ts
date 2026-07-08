import type { EventBus } from '../EventBus';
import type { BalanceConfigT, LevelDef, WhiteDist } from '../config';
import { getCardDef } from '../config';
import type { BeltView } from '../types';
import type { Card, CardCategory, GamePhase, BossTellTier } from '../types';
import { CardCategory as CC, CardState as CS } from '../types';
import type { Rng } from '../rng';

/**
 * 传送带系统（核心规则层，对应策划文档§3.2 / §4.3 / §5.4）。
 *
 * 模型：cards 为队列，index 0 = 处理区（最左），生成从最右 push。
 * 离散挡位：每个 slotPeriod 调用 step()，结算最左并整体左移一位。
 * "6 格"是瞄准扫描的目标窗口（由 PropSystem 按 level.slots 取前 N 个），队列长度可短可略长。
 *
 * 变更出口：通过事件驱动其它系统，自身不调用 Approval/Prop：
 *  - CardEnteredProcessing → ApprovalSystem 计算认可度变化
 *  - BossInspection         → ApprovalSystem.bossSettle
 *  - BossSpawned            → PropSystem §5.4②资源保底
 *  - BossIncoming           → 分级预警 Tell（AIActor/UI）
 */
export class ConveyorSystem implements BeltView {
  cards: Card[] = [];
  private frozen = false;
  private bossOnBelt = false;
  private lastBossTier: BossTellTier | null = null;
  private idSeq = 1;

  constructor(
    private cfg: BalanceConfigT,
    private level: LevelDef,
    private events: EventBus,
    private rng: Rng,
  ) {}

  get size(): number {
    return this.cards.length;
  }
  slotAt(i: number): Card | null {
    return this.cards[i] ?? null;
  }
  /** 当前活跃白卡（Boss 结算与威胁统计用） */
  get threatCards(): Card[] {
    return this.cards.filter((c) => c.state === CS.ActiveWhite);
  }
  hasBoss(): boolean {
    return this.bossOnBelt;
  }
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** §4.3 每挡位周期：结算最左并左移。Boss 抵达则触发临检结算。 */
  step(): void {
    if (this.frozen) return;
    const head = this.cards[0];
    if (head) {
      if (head.state === CS.Boss) {
        // §5.4 Boss临检：结算当前所有活跃白卡，且这些白卡视为"提前处理"被移除（防二次结算）
        const threats = this.threatCards;
        this.events.emit('BossInspection', { threatCards: threats });
        this.cards = this.cards.filter((c) => c.state !== CS.ActiveWhite);
        this.cards.shift(); // 移除 Boss 本体
        this.bossOnBelt = false;
        this.lastBossTier = null;
        this.events.emit('CardShifted', { tickIndex: this.idSeq++ });
        return;
      }
      this.events.emit('CardEnteredProcessing', { card: head });
    }
    this.cards.shift();
    this.events.emit('CardShifted', { tickIndex: this.idSeq++ });
    this.updateBossTell();
  }

  /** 生成一张卡进入入口（最右）。forceBoss 由 Game 按 Boss 规则判定后传入。 */
  generate(phase: GamePhase, opts?: { forceBoss?: boolean }): void {
    if (this.frozen) return;
    let card: Card;
    if (opts?.forceBoss) {
      card = this.mkCard(CC.Boss, CS.Boss);
      this.bossOnBelt = true;
      this.cards.push(card);
      this.events.emit('BossSpawned', { card });
      return;
    }
    if (this.rng.next() < this.level.idleCardRatio) {
      card = this.mkCard(this.rng.pick([CC.Meeting, CC.Document]), CS.Idle);
    } else {
      card = this.mkCard(this.pickCategory(phase), CS.ActiveWhite);
    }
    this.cards.push(card);
  }

  /** §4.2 加需求：在 slot 处插入灰插队卡，其后右移。 */
  insertGrayAt(slot: number): void {
    const s = clamp(slot, 0, this.cards.length);
    this.cards.splice(s, 0, this.mkCard(CC.Routine, CS.Inserted));
  }

  /** §4.2 改需求：把 slot 处活跃白卡变返工卡。返回是否成功。 */
  reworkAt(slot: number): boolean {
    const c = this.cards[slot];
    if (!c || c.state !== CS.ActiveWhite) return false;
    c.state = CS.Rework;
    return true;
  }

  /** §4.2 丢锅：以 slot 为中心炸 [slot-radius, slot+radius]。返回炸掉张数。 */
  clearRange(slot: number, radius: number): number {
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.cards.length - 1, slot + radius);
    if (lo > hi) return 0;
    const removed = this.cards.splice(lo, hi - lo + 1).length;
    if (!this.cards.some((c) => c.state === CS.Boss)) {
      this.bossOnBelt = false;
      this.lastBossTier = null;
    }
    return removed;
  }

  /** 丢锅命中前，判断范围内是否有卡（决定是否 Miss）。 */
  hasCardsInRange(slot: number, radius: number): boolean {
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.cards.length - 1, slot + radius);
    for (let i = lo; i <= hi; i++) if (this.cards[i]) return true;
    return false;
  }

  /** §5.4① Boss 分级预警：Boss 进入最后 tellSlots 格时按距离发 BossIncoming(tier)。 */
  private updateBossTell(): void {
    if (!this.bossOnBelt) return;
    const idx = this.cards.findIndex((c) => c.state === CS.Boss);
    if (idx < 0) {
      this.bossOnBelt = false;
      this.lastBossTier = null;
      return;
    }
    const tell = this.cfg.boss.tellSlots;
    if (idx < tell) {
      const tier = (idx + 1) as BossTellTier;
      if (this.lastBossTier !== tier) {
        this.lastBossTier = tier;
        this.events.emit('BossIncoming', { tier, slot: idx });
      }
    }
  }

  private pickCategory(phase: GamePhase): CardCategory {
    const dist: WhiteDist = this.level.whiteDistribution[phase];
    const entries: ReadonlyArray<[CardCategory, number]> = [
      [CC.Routine, dist.routine],
      [CC.Report, dist.report],
      [CC.Key, dist.key],
      [CC.Proposal, dist.proposal],
      [CC.Urgent, dist.urgent],
    ];
    const r = this.rng.next();
    let acc = 0;
    for (const [cat, p] of entries) {
      acc += p;
      if (r < acc) return cat;
    }
    return CC.Routine;
  }

  private mkCard(category: CardCategory, state: Card['state']): Card {
    const def = getCardDef(category);
    return {
      id: this.idSeq++,
      category,
      state,
      weight: def.weight,
      isThreat: state === CS.ActiveWhite,
    };
  }

  reset(): void {
    this.cards = [];
    this.frozen = false;
    this.bossOnBelt = false;
    this.lastBossTier = null;
  }

  /**
   * §2.1 复活辅助：清除场上所有 Boss 卡（避免复活后立刻二次死亡）。
   * 返回移除的 Boss 卡数量。
   */
  clearBoss(): number {
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => c.state !== CS.Boss);
    const removed = before - this.cards.length;
    if (removed > 0) {
      this.bossOnBelt = false;
      this.lastBossTier = null;
    }
    return removed;
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
