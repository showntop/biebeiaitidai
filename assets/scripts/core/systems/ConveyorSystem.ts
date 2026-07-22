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
  private linkSeq = 1;
  private pendingLinkCardId: number | null = null;

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
      // §5.4 Boss临检：前期只抽查最高风险任务，终局升级为全量扫描。
      // 被抽中的任务视为提前处理并移除；未抽中的任务继续留在队列，行为与文案一致。
      const allThreats = this.threatCards;
      const limit = this.level.boss.inspectionLimit;
      const inspected = limit === undefined
        ? allThreats
        : allThreats.slice().sort((a, b) => b.weight - a.weight).slice(0, Math.max(0, limit));
      const inspectedIds = new Set(inspected.map((card) => card.id));
      this.events.emit('BossInspection', {
        threatCards: inspected,
        totalThreats: allThreats.length,
        patternLabel: this.level.boss.patternLabel,
      });
      for (let i = 0; i < this.slots.length; i++) {
        const c = this.slots[i];
        if (c && (c.state === CS.Boss || inspectedIds.has(c.id))) this.slots[i] = null;
      }
      this.lastBossTier = null;
      this.shiftLeft();
      this.refreshLinks();
      this.events.emit('CardShifted', { tickIndex: this.idSeq++, outgoing: head });
      return;
    }
    if (head) this.events.emit('CardEnteredProcessing', { card: head });
    this.shiftLeft();
    this.refreshLinks();
    this.events.emit('CardShifted', { tickIndex: this.idSeq++, outgoing: head });
    this.updateBossTell();
  }

  /** 生成一张卡进入入口（slot N-1）。入口被占则丢弃本次生成。forceBoss 由 Game 按 Boss 规则判定后传入。 */
  generate(phase: GamePhase, opts?: { forceBoss?: boolean; allowModifiers?: boolean }): void {
    if (this.frozen) return;
    const entry = this.slots.length - 1;
    if (this.slots[entry] !== null) return; // 入口被占，丢弃（稀疏带几乎不发生）
    let card: Card;
    if (opts?.forceBoss) {
      card = this.mkCard(CC.Boss, CS.Boss);
      this.slots[entry] = card;
      this.events.emit('BossSpawned', {
        card,
        patternLabel: this.level.boss.patternLabel,
        inspectionLimit: this.level.boss.inspectionLimit,
      });
      this.applyBossArrivalEffect();
      return;
    }
    if (this.rng.next() < this.level.idleCardRatio) {
      card = this.mkCard(this.rng.pick([CC.Meeting, CC.Document]), CS.Idle);
    } else {
      card = this.mkCard(this.pickCategory(phase), CS.ActiveWhite);
    }
    this.slots[entry] = card;
    if (card.state === CS.ActiveWhite && opts?.allowModifiers !== false) this.applyTaskModifiers(card, phase);
  }

  /** §4.2 加需求：在 slot 处插入灰插队卡，其后整体右移一格（最右被挤出）。 */
  insertGrayAt(slot: number): void {
    const N = this.slots.length;
    const s = clamp(slot, 0, N - 1);
    for (let i = N - 1; i > s; i--) this.slots[i] = this.slots[i - 1];
    this.slots[s] = this.mkCard(CC.Routine, CS.Inserted);
    this.refreshLinks();
  }

  /** §4.2 改需求：把 slot 处活跃白卡变返工卡。返回是否成功。 */
  reworkAt(slot: number): boolean {
    return this.changeDemandAt(slot).changed;
  }

  /** 精英任务先破盾、再返工；返回真实收益，避免 Game/UI 自行猜测。 */
  changeDemandAt(slot: number): { changed: boolean; reworked: boolean; guardBroken: boolean; riskPrevented: number } {
    const c = this.slots[slot];
    if (!c || c.state !== CS.ActiveWhite) return { changed: false, reworked: false, guardBroken: false, riskPrevented: 0 };
    if ((c.guard ?? 0) > 0) {
      c.guard = Math.max(0, (c.guard ?? 0) - 1);
      const reduction = Math.min(c.weight, this.level.taskModifiers?.eliteGuardReduction ?? 2);
      c.baseWeight = Math.max(1, (c.baseWeight ?? c.weight) - reduction);
      c.weight = c.baseWeight + (c.linkBonus ?? 0);
      this.events.emit('EliteGuardBroken', { card: c, reduction });
      return { changed: true, reworked: false, guardBroken: true, riskPrevented: reduction };
    }
    const beforeWeight = c.weight;
    c.weight = c.baseWeight ?? c.weight;
    c.linkId = undefined;
    c.linkBonus = 0;
    c.state = CS.Rework;
    c.isThreat = false;
    this.refreshLinks();
    return { changed: true, reworked: true, guardBroken: false, riskPrevented: beforeWeight * 2 };
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
    this.refreshLinks();
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
    this.refreshLinks();
    return removed;
  }

  reset(): void {
    this.slots.fill(null);
    this.frozen = false;
    this.lastBossTier = null;
    this.pendingLinkCardId = null;
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
      baseWeight: def.weight,
      isThreat: state === CS.ActiveWhite,
    };
  }

  private applyTaskModifiers(card: Card, phase: GamePhase): void {
    const mods = this.level.taskModifiers;
    if (!mods) return;
    const eliteCount = this.threatCards.filter((candidate) => candidate.elite).length;
    const minWeight = mods.eliteMinWeight ?? 5;
    if (card.weight >= minWeight && eliteCount < (mods.maxElite ?? 2) && this.rng.next() < (mods.eliteRatio[phase] ?? 0)) {
      card.elite = true;
      card.guard = 1;
      card.baseWeight = card.weight + 2;
      card.weight = card.baseWeight;
      this.events.emit('EliteTaskSpawned', { card });
    }

    const pending = this.pendingLinkCardId === null
      ? null
      : this.threatCards.find((candidate) => candidate.id === this.pendingLinkCardId && candidate.id !== card.id);
    if (pending) {
      const bonus = mods.linkBonus ?? 1;
      const linkId = this.linkSeq++;
      pending.linkId = linkId;
      pending.linkBonus = bonus;
      pending.weight = (pending.baseWeight ?? pending.weight) + bonus;
      card.linkId = linkId;
      card.linkBonus = bonus;
      card.weight = (card.baseWeight ?? card.weight) + bonus;
      this.pendingLinkCardId = null;
      this.events.emit('TaskLinkFormed', { cards: [pending, card], bonus });
    } else {
      this.pendingLinkCardId = null;
      if (this.rng.next() < (mods.linkRatio[phase] ?? 0)) this.pendingLinkCardId = card.id;
    }
  }

  /** 任一伙伴离场/返工后，剩余任务立刻失去抱团风险。 */
  private refreshLinks(): void {
    if (this.pendingLinkCardId !== null && !this.threatCards.some((card) => card.id === this.pendingLinkCardId)) {
      this.pendingLinkCardId = null;
    }
    const groups = new Map<number, Card[]>();
    for (const card of this.threatCards) {
      if (card.linkId === undefined) continue;
      const group = groups.get(card.linkId) ?? [];
      group.push(card);
      groups.set(card.linkId, group);
    }
    for (const cards of groups.values()) {
      if (cards.length >= 2) continue;
      const remaining = cards[0];
      if (!remaining) continue;
      const bonusRemoved = remaining.linkBonus ?? 0;
      remaining.weight = remaining.baseWeight ?? Math.max(0, remaining.weight - bonusRemoved);
      remaining.linkId = undefined;
      remaining.linkBonus = 0;
      this.events.emit('TaskLinkBroken', { remaining, bonusRemoved });
    }
  }

  private applyBossArrivalEffect(): void {
    const effect = this.level.boss.arrivalEffect;
    if (!effect) return;
    const threats = this.threatCards.filter((card) => card.state === CS.ActiveWhite);
    if (threats.length === 0) return;
    const sorted = threats.slice().sort((a, b) => b.weight - a.weight);
    if (effect === 'escalate-highest') {
      const target = sorted[0];
      target.baseWeight = (target.baseWeight ?? target.weight) + 2;
      target.weight += 2;
      this.events.emit('BossArrivalEffect', {
        effect,
        affected: 1,
        label: '最高风险任务 +2',
        cardIds: [target.id],
      });
      return;
    }
    const targets = effect === 'fortify-all' ? threats : sorted.slice(0, 1);
    let affected = 0;
    const affectedTargets: Card[] = [];
    for (const target of targets) {
      if ((target.guard ?? 0) > 0) continue;
      target.elite = true;
      target.guard = 1;
      affected++;
      affectedTargets.push(target);
    }
    if (affected > 0) {
      this.events.emit('BossArrivalEffect', {
        effect,
        affected,
        label: effect === 'fortify-all' ? `全场 ${affected} 张任务加盾` : '最高风险任务加盾',
        cardIds: affectedTargets.map((target) => target.id),
      });
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
