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
 * 【模型】固定 N 个槽位（默认 6）的数组，index 0 = 处理区（最左），index N-1 = 入口（最右）。
 *  - generate()：在入口 slot(N-1) 放卡（若被占则本次生成丢弃，稀疏时几乎不发生）。
 *  - step()：结算 slot0，然后整体左移一格（slot[i]=slot[i+1]），slot(N-1)=null。
 *  ∴ 一张卡从入口走到处理区需要 N 步 ≈ N×slotPeriod（如 6×1.2s≈7.2s），
 *    给玩家充足的瞄准/出手时间——这是"蓄力扫描-松手"玩法的反应窗口。
 *
 * 旧实现用可变长队列(push/shift)，空带时新卡落在 index0 立即被结算(0.1s)，玩家无反应时间，
 * 属于模型错误；本固定槽位实现才是§4.3"卡牌占格、整体左移"的正确落地。
 *
 * 变更出口（事件驱动其它系统，自身不调 Approval/Prop）：
 *  - CardEnteredProcessing → ApprovalSystem 计算认可度变化
 *  - BossInspection         → ApprovalSystem.bossSettle
 *  - BossSpawned            → PropSystem §5.4②资源保底
 *  - BossIncoming           → 分级预警 Tell（AIActor/UI）
 */
export class ConveyorSystem implements BeltView {
  private slots: (Card | null)[];
  private frozen = false;
  private lastBossTier: BossTellTier | null = null;
  private idSeq = 1;

  constructor(
    private cfg: BalanceConfigT,
    private level: LevelDef,
    private events: EventBus,
    private rng: Rng,
  ) {
    this.slots = new Array(level.slots).fill(null);
  }

  /** 槽位数组（含空槽 null），index0=处理区。供表现层/bot 按槽位索引读取。 */
  get cards(): (Card | null)[] {
    return this.slots;
  }
  get size(): number {
    let n = 0;
    for (const c of this.slots) if (c) n++;
    return n;
  }
  slotAt(i: number): Card | null {
    return this.slots[i] ?? null;
  }
  /** 当前活跃白卡（Boss 结算与威胁统计用）。 */
  get threatCards(): Card[] {
    const out: Card[] = [];
    for (const c of this.slots) if (c && c.state === CS.ActiveWhite) out.push(c);
    return out;
  }
  hasBoss(): boolean {
    for (const c of this.slots) if (c && c.state === CS.Boss) return true;
    return false;
  }
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** §4.3 每挡位周期：结算 slot0 并整体左移。Boss 抵达则触发临检结算。 */
  step(): void {
    if (this.frozen) return;
    const head = this.slots[0];
    if (head && head.state === CS.Boss) {
      // §5.4 Boss临检：结算当前所有活跃白卡，且这些白卡视为"提前处理"被移除（防二次结算）
      this.events.emit('BossInspection', { threatCards: this.threatCards });
      for (let i = 0; i < this.slots.length; i++) {
        const c = this.slots[i];
        if (c && (c.state === CS.ActiveWhite || c.state === CS.Boss)) this.slots[i] = null;
      }
      this.lastBossTier = null;
      this.shiftLeft();
      this.events.emit('CardShifted', { tickIndex: this.idSeq++ });
      return;
    }
    if (head) this.events.emit('CardEnteredProcessing', { card: head });
    this.shiftLeft();
    this.events.emit('CardShifted', { tickIndex: this.idSeq++ });
    this.updateBossTell();
  }

  /** 生成一张卡进入入口（slot N-1）。入口被占则丢弃本次生成。forceBoss 由 Game 按 Boss 规则判定后传入。 */
  generate(phase: GamePhase, opts?: { forceBoss?: boolean }): void {
    if (this.frozen) return;
    const entry = this.slots.length - 1;
    if (this.slots[entry] !== null) return; // 入口被占，丢弃（稀疏带几乎不发生）
    let card: Card;
    if (opts?.forceBoss) {
      card = this.mkCard(CC.Boss, CS.Boss);
      this.slots[entry] = card;
      this.events.emit('BossSpawned', { card });
      return;
    }
    if (this.rng.next() < this.level.idleCardRatio) {
      card = this.mkCard(this.rng.pick([CC.Meeting, CC.Document]), CS.Idle);
    } else {
      card = this.mkCard(this.pickCategory(phase), CS.ActiveWhite);
    }
    this.slots[entry] = card;
  }

  /** §4.2 加需求：在 slot 处插入灰插队卡，其后整体右移一格（最右被挤出）。 */
  insertGrayAt(slot: number): void {
    const N = this.slots.length;
    const s = clamp(slot, 0, N - 1);
    for (let i = N - 1; i > s; i--) this.slots[i] = this.slots[i - 1];
    this.slots[s] = this.mkCard(CC.Routine, CS.Inserted);
  }

  /** §4.2 改需求：把 slot 处活跃白卡变返工卡。返回是否成功。 */
  reworkAt(slot: number): boolean {
    const c = this.slots[slot];
    if (!c || c.state !== CS.ActiveWhite) return false;
    c.state = CS.Rework;
    return true;
  }

  /** §4.2 丢锅：以 slot 为中心炸 [slot-radius, slot+radius]，留出空档（不压缩，空档随传送带左移）。 */
  clearRange(slot: number, radius: number): number {
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.slots.length - 1, slot + radius);
    let removed = 0;
    for (let i = lo; i <= hi; i++) {
      if (this.slots[i]) {
        this.slots[i] = null;
        removed++;
      }
    }
    if (removed > 0) this.lastBossTier = null; // 可能炸掉 Boss，重置预警
    return removed;
  }

  /** 丢锅命中前，判断范围内是否有卡（决定是否 Miss）。 */
  hasCardsInRange(slot: number, radius: number): boolean {
    const lo = Math.max(0, slot - radius);
    const hi = Math.min(this.slots.length - 1, slot + radius);
    for (let i = lo; i <= hi; i++) if (this.slots[i]) return true;
    return false;
  }

  /** §2.1 复活辅助：清除场上所有 Boss 卡。 */
  clearBoss(): number {
    let removed = 0;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]?.state === CS.Boss) {
        this.slots[i] = null;
        removed++;
      }
    }
    if (removed > 0) this.lastBossTier = null;
    return removed;
  }

  reset(): void {
    this.slots.fill(null);
    this.frozen = false;
    this.lastBossTier = null;
  }

  /* ---------- 内部 ---------- */

  private shiftLeft(): void {
    const N = this.slots.length;
    for (let i = 0; i < N - 1; i++) this.slots[i] = this.slots[i + 1];
    this.slots[N - 1] = null;
  }

  /** §5.4① Boss 分级预警：Boss 进入最后 tellSlots 格时按距离发 BossIncoming(tier)。 */
  private updateBossTell(): void {
    const idx = this.slots.findIndex((c) => c && c.state === CS.Boss);
    if (idx < 0) {
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
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
