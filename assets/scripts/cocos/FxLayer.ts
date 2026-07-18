import { tween, Tween, Vec3, Node, Label, Color, UITransform, UIOpacity, Graphics } from 'cc';
import type { EventBus } from '../core/EventBus';
import type { ExpressionId, GameEvents, HitQuality, ApprovalZone } from '../core/types';

const UI_2D = 1 << 25; // 33554432

/**
 * 表现层动效系统 —— 订阅 core EventBus 事件，驱动 Cocos tween 动画。
 *
 * 纯演出层，不回写判定层（符合开发计划§2 架构纪律）。
 * 每局 startGame 时创建，换关时 dispose 释放旧订阅。
 *
 * 动效清单：
 *  - CardHit      → 挡位缩放打击 + 横向抖动 + Perfect 金字
 *  - PerfectRewardGranted → 金色奖励爆发 + 明确奖励文案
 *  - CardResolved → 认可度旁浮动 +N/-N
 *  - ApprovalChanged → 认可度 Label 闪绿/红
 *  - ZoneChanged → 局部状态横幅 + 边缘提示
 *  - ComboUpdated → 连击数浮字
 *  - BossSpawned  → 目标预警 + 边缘警报 + "BOSS 临检"
 *  - BossInspection → 扫描线 + 边缘警报
 *  - KissUpFreeze → 传送带冻结波纹 + 状态横幅
 *  - Revived      → 金色局部爆发 + "复活 +8s"
 *  - GameOver     → 轻屏震
 *  - HuntChargeStart → 认可度局部脉冲 + "猎杀倒计时"
 *  - HuntChargeBreak → 认可度局部爆发 + "脱险"
 *  - BossIncoming → 卡片目标分级预警（tier 越近节奏越急）
 *  - PropUnavailable → 灰色 "Miss" 浮字
 *  - PropCanceled   → 灰色 "取消" 浮字
 *  - AIHit        → AI 本体局部爆发 + "拍中/完美拍中"
 */
export class FxLayer {
  private unsubs: (() => void)[] = [];

  /** root 初始位置：屏震每次先归位到此基准，避免多次震动叠加导致画面残留偏移。 */
  private readonly rootBase: Vec3;
  /** approvalLabel 初始色：闪色恢复目标，避免连续触发时把"已改色"误记为基准。 */
  private approvalBaseColor: Color | null = null;

  constructor(
    private bus: EventBus,
    private root: Node,
    private slots: Node[],
    private approvalLabel: Label | null,
    private getSlotVisual: (slot: number) => Node | null = () => null,
    private getCardVisual: (cardId: number) => Node | null = () => null,
    private getCharacterNode: () => Node | null = () => null,
  ) {
    this.rootBase = root.position.clone();
    if (approvalLabel && approvalLabel.isValid) this.approvalBaseColor = approvalLabel.color.clone();
    this.refreshSlotBases();
    this.bind();
  }

  private slotBases: Vec3[] = [];

  /** 布局层重排卡槽后刷新逻辑中心点；动效始终以这些基准点计算，避免连续 tween 漂移。 */
  refreshSlotBases(): void {
    this.slotBases = this.slots.map((slot) => slot?.isValid ? slot.position.clone() : new Vec3());
  }

  /** 释放所有事件订阅 + 停掉进行中的震动/闪色 tween（换关前调用）。 */
  dispose(): void {
    this.unsubs.forEach(fn => fn());
    this.unsubs = [];
    Tween.stopAllByTarget(this.root);
    if (this.approvalLabel?.isValid) Tween.stopAllByTarget(this.approvalLabel.node);
  }

  /* ---------- 事件绑定 ---------- */

  private bind(): void {
    this.on('CardHit', ({ slot, quality, prop }) => this.fxCardHit(slot, quality, prop));
    this.on('PerfectRewardGranted', ({ reward }) => this.fxPerfectReward(reward));
    this.on('CardResolved', ({ delta, card }) => this.fxCardResolved(delta, card));
    this.on('ApprovalChanged', ({ delta }) => this.fxApprovalChange(delta));
    this.on('ZoneChanged', ({ to }) => this.fxZoneChange(to));
    this.on('ComboUpdated', ({ combo }) => this.fxCombo(combo));
    this.on('PhaseChanged', ({ to }) => this.fxPhaseChanged(to));
    this.on('BossSpawned', () => this.fxBossSpawned());
    this.on('BossInspection', () => this.fxBossInspection());
    this.on('KissUpFreeze', ({ durationSec }) => this.fxKissUpFreeze(durationSec));
    this.on('Revived', () => this.fxRevived());
    this.on('GameOver', () => this.fxGameOver());
    this.on('HuntChargeStart', () => this.fxHuntCharge());
    this.on('HuntChargeBreak', () => this.fxHuntBreak());
    this.on('BossIncoming', ({ tier, slot }) => this.fxBossIncoming(tier, slot));
    this.on('PropUnavailable', ({ slot, reason }) => this.fxMiss(slot, reason));
    this.on('PropCanceled', () => this.fxCancel());
    this.on('AIHit', ({ quality }) => this.fxAIHit(quality));
    this.on('AIExpression', ({ expression, durationSec }) => this.fxAIExpression(expression, durationSec));
    this.on('Highlight', ({ label, tier }) => this.fxHighlight(label, tier));
  }

  private on<K extends keyof GameEvents>(name: K, fn: (p: GameEvents[K]) => void): void {
    this.unsubs.push(this.bus.on(name, fn));
  }

  /* ---------- 道具命中 ---------- */

  private fxCardHit(slot: number, quality: HitQuality, prop: GameEvents['CardHit']['prop']): void {
    const node = this.getSlotVisual(slot) ?? this.slots[slot];
    if (!node || !node.isValid) return;

    const punch = quality === 'perfect' ? 1.16 : 1.08;
    const origin = this.pointInRoot(node);
    // 小幅卡面弹性即可；强反馈交给盖章和碎纸粒，避免整张卡撞到相邻卡。
    tween(node)
      .to(0.045, { scale: new Vec3(punch, 0.96, 1) }, { easing: 'quadOut' })
      .to(0.10, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
      .start();
    this.cardEdgeSweep(node, prop, quality);
    this.cardImpactBurst(origin, prop, quality);
    this.cardHitStamp(node, prop, quality);
    this.shake(quality === 'perfect' ? 3.6 : 2.2, quality === 'perfect' ? 0.16 : 0.10);
    // Perfect 额外金字
    if (quality === 'perfect') {
      this.floatText('PERFECT!', origin.x, origin.y + 46, new Color(255, 204, 64), 0.58);
    }
  }

  private cardEdgeSweep(cardNode: Node, prop: GameEvents['CardHit']['prop'], quality: HitQuality): void {
    const ut = cardNode.getComponent(UITransform);
    const w = Math.max(70, ut?.width ?? 86);
    const h = Math.max(62, ut?.height ?? 78);
    const color = this.propAccent(prop);
    const sweep = new Node('CardEdgeSweep');
    sweep.layer = UI_2D;
    sweep.parent = cardNode;
    sweep.addComponent(UITransform).setContentSize(w, h);
    sweep.setPosition(0, 0, 0);
    const g = sweep.addComponent(Graphics);
    const strong = quality === 'perfect';
    g.strokeColor = new Color(color.r, color.g, color.b, strong ? 220 : 168);
    g.lineWidth = strong ? 4 : 3;
    g.roundRect(-w * 0.43, -h * 0.38, w * 0.86, h * 0.76, 14);
    g.stroke();
    g.fillColor = new Color(255, 255, 255, strong ? 76 : 48);
    g.roundRect(-w * 0.38, h * 0.23, w * 0.30, 5, 3);
    g.fill();
    const op = sweep.addComponent(UIOpacity);
    op.opacity = 0;
    sweep.setScale(0.92, 0.92, 1);
    tween(op)
      .to(0.04, { opacity: strong ? 255 : 205 }, { easing: 'quadOut' })
      .to(strong ? 0.26 : 0.20, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(sweep)
      .to(strong ? 0.30 : 0.24, { scale: new Vec3(strong ? 1.12 : 1.06, strong ? 1.12 : 1.06, 1) }, { easing: 'quadOut' })
      .call(() => { if (sweep.isValid) sweep.destroy(); })
      .start();
  }

  private cardHitStamp(cardNode: Node, prop: GameEvents['CardHit']['prop'], quality: HitQuality): void {
    const ut = cardNode.getComponent(UITransform);
    const w = ut?.width ?? 86;
    const h = ut?.height ?? 80;
    const color = this.propAccent(prop);
    const text = this.propStampText(prop, quality);

    const stamp = new Node('CardHitStamp');
    stamp.layer = UI_2D;
    stamp.parent = cardNode;
    stamp.addComponent(UITransform).setContentSize(Math.min(70, w * 0.72), 34);
    stamp.setPosition(w * 0.17, -h * 0.14, 0);
    stamp.angle = -8;
    stamp.setScale(1.38, 1.38, 1);
    const g = stamp.addComponent(Graphics);
    g.fillColor = new Color(255, 252, 246, 238);
    g.strokeColor = color;
    g.lineWidth = 3;
    g.roundRect(-34, -15, 68, 30, 8);
    g.fill(); g.stroke();
    g.strokeColor = new Color(color.r, color.g, color.b, 126);
    g.lineWidth = 1.5;
    g.roundRect(-28, -10, 56, 20, 5);
    g.stroke();

    const labelNode = new Node('CardHitStampText');
    labelNode.layer = UI_2D;
    labelNode.parent = stamp;
    labelNode.addComponent(UITransform).setContentSize(66, 28);
    const label = labelNode.addComponent(Label);
    label.string = text;
    label.fontSize = quality === 'perfect' ? 18 : 16;
    label.lineHeight = 20;
    label.isBold = true;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;

    const op = stamp.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.04, { opacity: 255 }, { easing: 'quadOut' })
      .delay(0.34)
      .to(0.18, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(stamp)
      .to(0.05, { scale: new Vec3(0.94, 0.94, 1) }, { easing: 'backOut' })
      .delay(0.34)
      .to(0.18, { scale: new Vec3(0.74, 0.74, 1) }, { easing: 'quadIn' })
      .call(() => { if (stamp.isValid) stamp.destroy(); })
      .start();
  }

  private cardImpactBurst(origin: Vec3, prop: GameEvents['CardHit']['prop'], quality: HitQuality): void {
    const burst = new Node('CardImpactBurst');
    burst.layer = UI_2D;
    burst.addComponent(UITransform).setContentSize(96, 96);
    const g = burst.addComponent(Graphics);
    const color = this.propAccent(prop);
    const strong = quality === 'perfect';
    g.clear();
    g.strokeColor = new Color(color.r, color.g, color.b, strong ? 230 : 185);
    g.lineWidth = strong ? 4 : 3;
    g.circle(0, 0, strong ? 21 : 16);
    g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, strong ? 230 : 185);
    const rays = strong ? 10 : 7;
    for (let i = 0; i < rays; i++) {
      const a = (Math.PI * 2 * i) / rays;
      const inner = strong ? 27 : 22;
      const outer = strong ? 40 : 34;
      g.circle(Math.cos(a) * outer, Math.sin(a) * outer, i % 2 === 0 ? 3.5 : 2.5);
      g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    }
    g.fill();
    g.stroke();
    burst.setPosition(origin.x, origin.y, 0);
    burst.setScale(0.72, 0.72, 1);
    this.root.addChild(burst);
    const op = burst.addComponent(UIOpacity);
    op.opacity = strong ? 235 : 190;
    tween(burst)
      .to(strong ? 0.30 : 0.24, { scale: new Vec3(strong ? 1.40 : 1.20, strong ? 1.40 : 1.20, 1), angle: strong ? 12 : 8 }, { easing: 'quadOut' })
      .call(() => { if (burst.isValid) burst.destroy(); })
      .start();
    tween(op).delay(0.08).to(strong ? 0.22 : 0.18, { opacity: 0 }, { easing: 'quadIn' }).start();
  }

  private propStampText(prop: GameEvents['CardHit']['prop'], quality: HitQuality): string {
    if (quality === 'perfect') return '完美';
    if (prop === 'add-demand') return '加急';
    if (prop === 'change-demand') return '返工';
    if (prop === 'throw-pot') return '甩锅';
    return '拍中';
  }

  private propAccent(prop: GameEvents['CardHit']['prop']): Color {
    if (prop === 'add-demand') return new Color(106, 140, 168, 255);
    if (prop === 'change-demand') return new Color(150, 80, 190, 255);
    if (prop === 'throw-pot') return new Color(198, 92, 70, 255);
    return new Color(244, 172, 32, 255);
  }

  private fxPerfectReward(reward: GameEvents['PerfectRewardGranted']['reward']): void {
    const labels: Record<GameEvents['PerfectRewardGranted']['reward'], string> = {
      'cd-refill-10': '奖励 · 冷却回退 10%',
      'extra-use': '奖励 · 道具次数 +1',
      'energy-full': '奖励 · 立即充满',
    };
    const origin = this.approvalTargetPoint();
    const color = new Color(246, 190, 54, 255);
    this.rewardBurst(new Vec3(origin.x, origin.y + 18, 0), color, 0.70, true);
    this.statusBanner(labels[reward], color, 0.94, 92);
  }

  /* ---------- 卡牌结算（浮动 ±N） ---------- */

  private fxCardResolved(delta: number, card: GameEvents['CardResolved']['card']): void {
    const startNode = this.getCardVisual(card.id) ?? this.getSlotVisual(0) ?? this.slots[0] ?? this.approvalLabel?.node;
    if (!startNode?.isValid) return;
    const start = this.pointInRoot(startNode);
    const target = this.approvalTargetPoint();
    const color = this.resolveColor(delta);
    const text = this.resolveText(delta, card.state);
    this.scanProcessingCard(startNode, delta);
    if (delta !== 0) {
      this.flyResolvedCard(text, color, start, target);
      this.floatText(text, target.x, target.y + 24, color, 0.72, 24);
      this.approvalPulse(delta, target);
    } else {
      this.floatText('已归档', start.x, start.y + 38, new Color(122, 113, 101, 230), 0.52, 18);
    }
  }

  /* ---------- 认可度变化（Label 闪色） ---------- */

  private fxApprovalChange(delta: number): void {
    const label = this.approvalLabel;
    if (!label || !label.isValid || !this.approvalBaseColor) return;
    // 停掉上一次的延迟恢复，否则连续触发会排队把基准色覆盖成中间色
    Tween.stopAllByTarget(label.node);
    label.color = delta > 0 ? new Color(226, 64, 54) : new Color(78, 170, 74);
    const pop = delta > 0 ? 1.13 : 1.09;
    label.node.setScale(pop, pop, 1);
    tween(label.node)
      .to(0.16, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
      .delay(0.10)
      .call(() => { if (label?.isValid) label.color = this.approvalBaseColor!; })
      .start();
    if (Math.abs(delta) >= 6) this.shake(delta > 0 ? 3.4 : 2.0, 0.14);
  }

  /* ---------- 分区跨越（状态横幅 + 克制边缘提示） ---------- */

  private fxZoneChange(to: ApprovalZone): void {
    const states: Record<string, { text: string; color: Color }> = {
      hunt: { text: '反杀线 · 稳住就能提前通关', color: new Color(246, 190, 54, 255) },
      good: { text: '状态良好 · 节奏在你手里', color: new Color(78, 170, 74, 255) },
      ok: { text: '进入一般区 · 注意任务堆积', color: new Color(221, 171, 43, 255) },
      danger: { text: '危险区 · AI 正在接管', color: new Color(226, 64, 54, 255) },
    };
    const state = states[to];
    if (!state) return;
    this.statusBanner(state.text, state.color, 0.82, 120);
    if (to === 'danger' || to === 'hunt') this.edgeAlarm(state.color, to === 'danger' ? 0.78 : 0.58, 0.52);
    this.approvalPulse(to === 'danger' ? 1 : -1, this.approvalTargetPoint());
  }

  /* ---------- 连击 ---------- */

  private fxCombo(combo: number): void {
    if (combo < 2) return;
    const color = combo >= 5 ? new Color(255, 100, 50) : new Color(255, 200, 50);
    this.comboBurst(combo, color);
  }

  private fxPhaseChanged(to: GameEvents['PhaseChanged']['to']): void {
    if (to === 'early') return;
    const crisis = to === 'crisis';
    const color = crisis ? new Color(214, 92, 62, 255) : new Color(216, 142, 66, 255);
    this.statusBanner(crisis ? '最后冲刺 · 队列全速运转' : '中盘加速 · 新任务变多', color, 0.98, 112);
    if (crisis) this.edgeAlarm(color, 0.46, 0.46);
  }

  /* ---------- Boss ---------- */

  private fxBossSpawned(): void {
    const color = new Color(198, 72, 62, 255);
    this.shake(4.2, 0.24);
    this.edgeAlarm(color, 0.72, 0.72);
    this.statusBanner('BOSS 临检进入队列', color, 1.05, 118);
  }

  private fxBossInspection(): void {
    const color = new Color(198, 72, 62, 255);
    this.shake(7, 0.36);
    this.edgeAlarm(color, 1, 0.88);
    this.scanSweep(color, 0.62);
    this.statusBanner('临检结算 · 正在扫描任务', color, 0.92, 104);
  }

  /* ---------- 拍马屁冻结 ---------- */

  private fxKissUpFreeze(durationSec: number): void {
    const color = new Color(106, 140, 168, 255);
    this.beltFreezeWave(color, Math.min(1.1, Math.max(0.56, durationSec * 0.55)));
    this.statusBanner('拍马屁生效 · 传送带暂停', color, Math.max(durationSec, 0.9), 78);
  }

  /* ---------- 复活 ---------- */

  private fxRevived(): void {
    const color = new Color(246, 190, 54, 255);
    this.rewardBurst(new Vec3(0, 48, 0), color, 0.72, true);
    this.statusBanner('复活成功 · 时间 +8s', color, 1.0, 82);
  }

  /* ---------- 游戏结束 ---------- */

  private fxGameOver(): void {
    this.shake(4, 0.2);
  }

  /* ---------- 本局高光：局部纸质横幅，不用红/黄整屏闪烁 ---------- */

  private fxHighlight(label: string, tier: number): void {
    const color = tier >= 3
      ? new Color(225, 151, 38, 255)
      : tier === 2
        ? new Color(54, 143, 221, 255)
        : new Color(83, 160, 119, 255);
    const title = tier >= 3 ? `本局高光 · ${label}` : `漂亮 · ${label}`;
    this.statusBanner(title, color, tier >= 3 ? 1.25 : 0.82, 142);
    if (tier >= 2) this.rewardBurst(new Vec3(0, 118, 0), color, tier >= 3 ? 0.72 : 0.5, tier >= 3);
    if (tier >= 3) this.shake(3.2, 0.16);
  }

  /* ---------- 猎杀线 ---------- */

  private fxHuntCharge(): void {
    const color = new Color(246, 190, 54, 255);
    const target = this.approvalTargetPoint();
    this.approvalPulse(-1, target);
    this.statusBanner('反杀窗口开启 · 稳住 2 秒', color, 1.1, 108);
    this.edgeAlarm(color, 0.46, 0.72);
  }

  /* ---------- 猎杀中断（脱险） ---------- */

  private fxHuntBreak(): void {
    const color = new Color(78, 170, 74, 255);
    const target = this.approvalTargetPoint();
    this.rewardBurst(target, color, 0.58);
    this.statusBanner('脱险 · 重新控住节奏', color, 0.86, 94);
  }

  /* ---------- Boss 分级预警（4格递进，越近越急） ---------- */

  private fxBossIncoming(tier: number, slot: number): void {
    // tier: 4 最远 → 1 最近；越近 urgency 越高，预警围绕 Boss 卡本身收紧。
    const urgency = (5 - tier) / 4; // 4→0.25 … 1→1
    const color = tier <= 2 ? new Color(214, 74, 62, 255) : new Color(221, 154, 54, 255);
    const target = this.getSlotVisual(slot) ?? this.slots[slot];
    if (target?.isValid) this.targetWarning(target, color, urgency);
    if (tier <= 2) {
      this.shake(1.4 + urgency * 2.2, 0.14 + urgency * 0.08);
      this.statusBanner(tier === 1 ? '临检下一格抵达!' : 'BOSS 正在逼近', color, 0.64, 96);
    }
  }

  /* ---------- Miss / 取消 / 拍马屁命中 ---------- */

  private fxMiss(slot: number, reason: GameEvents['PropUnavailable']['reason']): void {
    const target = this.getSlotVisual(slot) ?? this.slots[slot];
    const p = target?.isValid ? this.pointInRoot(target) : new Vec3(0, 70, 0);
    if (target?.isValid) {
      Tween.stopAllByTarget(target);
      tween(target)
        .to(0.05, { scale: new Vec3(0.96, 0.96, 1), angle: -2 }, { easing: 'quadOut' })
        .to(0.09, { scale: new Vec3(1, 1, 1), angle: 0 }, { easing: 'backOut' })
        .start();
    }
    this.floatText(reason === 'empty' ? '空挡' : '目标无效', p.x, p.y + 34, new Color(122, 113, 101, 245), 0.56, 20);
  }

  private fxCancel(): void {
    this.floatText('取消', 0, -30, new Color(150, 150, 150), 0.5);
  }

  private fxAIHit(quality: HitQuality): void {
    const perfect = quality === 'perfect';
    const ai = this.getCharacterNode();
    const p = ai?.isValid ? this.pointInRoot(ai) : new Vec3(0, 40, 0);
    const color = perfect ? new Color(232, 154, 92, 255) : new Color(202, 126, 140, 255);
    this.rewardBurst(new Vec3(p.x, p.y + 18, 0), color, perfect ? 0.66 : 0.48, perfect);
    this.aiStatusChip(perfect ? '完美拍中!' : '拍中!', p.x, p.y + 84, color, perfect ? 0.72 : 0.52);
    // AI 本体动作由随后发出的 AIExpression 统一驱动，避免同一次命中叠两套 tween。
  }

  private fxAIExpression(expression: ExpressionId, durationSec: number): void {
    this.pulseCharacter(expression, durationSec);
    const ai = this.getCharacterNode();
    if (!ai?.isValid) return;
    const p = this.pointInRoot(ai);
    const copy: Partial<Record<ExpressionId, string>> = {
      'slight-frown': '警觉',
      surprised: '被打断!',
      bewildered: '甩懵了',
      'combo-face': '连击!',
      confident: '稳住',
      sweat: '有点慌',
      panic: '危险!',
      'busy-pretend': '装忙中',
      shy: '被夸了',
      'idle-look': '摸鱼?',
      tense: '紧张',
      facepalm: '捂脸了',
      crashed: '死机中',
      'called-in': '约谈',
    };
    const color = this.expressionColor(expression);
    if (expression === 'shy') return; // AIHit 已给出“拍中”奖励文案，避免重复气泡。
    this.aiStatusChip(copy[expression] ?? '状态变化', p.x, p.y + 92, color, Math.min(1.0, Math.max(0.42, durationSec)));
  }

  private pulseCharacter(expression: ExpressionId, durationSec: number): void {
    const ai = this.getCharacterNode();
    if (!ai?.isValid) return;
    Tween.stopAllByTarget(ai);
    const stress = expression === 'panic' || expression === 'tense' || expression === 'busy-pretend' || expression === 'facepalm';
    const happy = expression === 'confident' || expression === 'shy' || expression === 'combo-face';
    const crashed = expression === 'crashed';
    const sx = crashed ? 1.06 : stress ? 0.97 : happy ? 1.04 : 1.02;
    const sy = crashed ? 0.92 : stress ? 1.05 : happy ? 0.97 : 1.02;
    const angle = crashed ? -5 : stress ? 3 : happy ? -2 : 0;
    tween(ai)
      .to(0.08, { scale: new Vec3(sx, sy, 1), angle }, { easing: 'quadOut' })
      .delay(Math.min(0.28, Math.max(0.08, durationSec * 0.35)))
      .to(0.16, { scale: new Vec3(1, 1, 1), angle: 0 }, { easing: 'backOut' })
      .start();
  }

  private aiStatusChip(text: string, x: number, y: number, color: Color, duration: number): void {
    const node = new Node('AIStatusChip');
    node.layer = UI_2D;
    node.addComponent(UITransform).setContentSize(96, 30);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(255, 252, 246, 235);
    g.strokeColor = new Color(color.r, color.g, color.b, 210);
    g.lineWidth = 2.5;
    g.roundRect(-48, -15, 96, 30, 12);
    g.fill(); g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, 54);
    g.roundRect(-38, -11, 76, 5, 3);
    g.fill();
    const labelNode = new Node('AIStatusText');
    labelNode.layer = UI_2D;
    labelNode.parent = node;
    labelNode.addComponent(UITransform).setContentSize(90, 26);
    const label = labelNode.addComponent(Label);
    label.string = text;
    label.fontSize = 16;
    label.lineHeight = 20;
    label.isBold = true;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    node.setPosition(x, y, 0);
    this.root.addChild(node);
    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.08, { opacity: 245 }, { easing: 'quadOut' })
      .delay(duration)
      .to(0.18, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(node)
      .by(duration + 0.26, { position: new Vec3(0, 22, 0) }, { easing: 'quadOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  private expressionColor(expression: ExpressionId): Color {
    if (expression === 'panic' || expression === 'tense' || expression === 'busy-pretend' || expression === 'facepalm') return new Color(226, 64, 54, 255);
    if (expression === 'surprised' || expression === 'bewildered' || expression === 'combo-face' || expression === 'crashed') return new Color(244, 172, 32, 255);
    if (expression === 'confident' || expression === 'shy' || expression === 'called-in') return new Color(78, 170, 74, 255);
    return new Color(106, 140, 168, 255);
  }

  private scanProcessingCard(cardNode: Node, delta: number): void {
    const ut = cardNode.getComponent(UITransform);
    const w = Math.max(70, ut?.width ?? 86);
    const h = Math.max(62, ut?.height ?? 78);
    const color = this.resolveColor(delta);
    const scan = new Node('ProcessingScan');
    scan.layer = UI_2D;
    scan.parent = cardNode;
    scan.addComponent(UITransform).setContentSize(w, h);
    scan.setPosition(0, 0, 0);
    const g = scan.addComponent(Graphics);
    g.fillColor = new Color(color.r, color.g, color.b, delta === 0 ? 22 : 34);
    g.roundRect(-w * 0.43, -h * 0.36, w * 0.86, h * 0.72, 12);
    g.fill();
    g.strokeColor = new Color(color.r, color.g, color.b, delta === 0 ? 116 : 168);
    g.lineWidth = 2;
    g.roundRect(-w * 0.43, -h * 0.36, w * 0.86, h * 0.72, 12);
    g.stroke();

    const line = new Node('ProcessingScanLine');
    line.layer = UI_2D;
    line.parent = scan;
    line.addComponent(UITransform).setContentSize(w, h);
    line.setPosition(-w * 0.34, 0, 0);
    const lg = line.addComponent(Graphics);
    lg.fillColor = new Color(255, 252, 236, 210);
    lg.roundRect(-2, -h * 0.30, 4, h * 0.60, 2);
    lg.fill();
    lg.fillColor = new Color(color.r, color.g, color.b, 160);
    lg.roundRect(2, -h * 0.24, 3, h * 0.48, 2);
    lg.fill();

    const labelNode = new Node('ProcessingLabel');
    labelNode.layer = UI_2D;
    labelNode.parent = scan;
    labelNode.addComponent(UITransform).setContentSize(w, 24);
    labelNode.setPosition(0, h * 0.03, 0);
    const label = labelNode.addComponent(Label);
    label.string = delta > 0 ? '风险录入' : delta < 0 ? '风险回收' : '已处理';
    label.fontSize = 16;
    label.lineHeight = 20;
    label.isBold = true;
    label.color = new Color(color.r, color.g, color.b, 238);
    label.horizontalAlign = 1;
    label.verticalAlign = 1;

    const op = scan.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.04, { opacity: 255 }, { easing: 'quadOut' })
      .delay(0.26)
      .to(0.14, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(line)
      .to(0.22, { position: new Vec3(w * 0.34, 0, 0) }, { easing: 'quadInOut' })
      .start();
    tween(scan)
      .to(0.05, { scale: new Vec3(1.04, 1.04, 1) }, { easing: 'quadOut' })
      .to(0.10, { scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' })
      .delay(0.24)
      .call(() => { if (scan.isValid) scan.destroy(); })
      .start();
  }

  private flyResolvedCard(text: string, color: Color, start: Vec3, target: Vec3): void {
    const node = new Node('ResolvedCardFly');
    node.layer = UI_2D;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(82, 46);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(250, 246, 236, 255);
    g.strokeColor = color;
    g.lineWidth = 3;
    g.roundRect(-41, -23, 82, 46, 12);
    g.fill();
    g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, 95);
    g.roundRect(-30, -17, 60, 5, 3);
    g.fill();
    // Graphics 和 Label 都是可渲染组件，Cocos 不允许挂在同一节点。
    const labelNode = new Node('ResolvedCardValue');
    labelNode.layer = UI_2D;
    labelNode.parent = node;
    labelNode.addComponent(UITransform).setContentSize(82, 46);
    labelNode.setPosition(0, 0, 0);
    const label = labelNode.addComponent(Label);
    label.string = text;
    label.fontSize = 22;
    label.lineHeight = 28;
    label.isBold = true;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    node.setPosition(start.x, start.y, 0);
    this.root.addChild(node);
    const op = node.addComponent(UIOpacity);
    op.opacity = 255;
    const peak = new Vec3((start.x + target.x) / 2, Math.max(start.y, target.y) + 86, 0);
    tween(node)
      .to(0.18, { position: peak, scale: new Vec3(0.86, 0.86, 1), angle: text.includes('-') ? -8 : 8 }, { easing: 'quadOut' })
      .to(0.28, { position: target, scale: new Vec3(0.36, 0.36, 1), angle: 0 }, { easing: 'quadIn' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
    tween(op).delay(0.28).to(0.16, { opacity: 0 }, { easing: 'quadIn' }).start();
  }

  private approvalTargetPoint(): Vec3 {
    if (this.approvalLabel?.node?.isValid) {
      const p = this.pointInRoot(this.approvalLabel.node);
      return new Vec3(p.x + 8, p.y - 8, 0);
    }
    return new Vec3(0, -260, 0);
  }

  private approvalPulse(delta: number, target: Vec3): void {
    const color = this.resolveColor(delta);
    const pulse = new Node('ApprovalPulse');
    pulse.layer = UI_2D;
    pulse.addComponent(UITransform).setContentSize(130, 56);
    const g = pulse.addComponent(Graphics);
    g.strokeColor = new Color(color.r, color.g, color.b, delta > 0 ? 180 : 140);
    g.lineWidth = delta > 0 ? 4 : 3;
    g.roundRect(-60, -22, 120, 44, 22);
    g.stroke();
    pulse.setPosition(target.x, target.y, 0);
    pulse.setScale(0.82, 0.82, 1);
    this.root.addChild(pulse);
    const op = pulse.addComponent(UIOpacity);
    op.opacity = delta > 0 ? 210 : 160;
    tween(pulse)
      .to(delta > 0 ? 0.34 : 0.26, { scale: new Vec3(delta > 0 ? 1.24 : 1.10, delta > 0 ? 1.24 : 1.10, 1) }, { easing: 'quadOut' })
      .call(() => { if (pulse.isValid) pulse.destroy(); })
      .start();
    tween(op).to(delta > 0 ? 0.34 : 0.26, { opacity: 0 }, { easing: 'quadIn' }).start();
  }

  /**
   * 状态横幅：用短暂的纸质胶囊承载关键状态，不遮挡玩法区，也不改变整屏底色。
   */
  private statusBanner(text: string, color: Color, duration: number, y: number): void {
    const width = Math.max(210, Math.min(360, 76 + text.length * 18));
    const node = new Node('FxStatusBanner');
    node.layer = UI_2D;
    node.addComponent(UITransform).setContentSize(width, 48);
    node.setPosition(0, y - 10, 0);
    node.setScale(0.92, 0.92, 1);
    this.root.addChild(node);

    const g = node.addComponent(Graphics);
    g.fillColor = new Color(54, 48, 42, 34);
    g.roundRect(-width / 2 + 2, -25, width - 4, 46, 20);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 248);
    g.strokeColor = new Color(color.r, color.g, color.b, 190);
    g.lineWidth = 2.5;
    g.roundRect(-width / 2, -21, width, 42, 19);
    g.fill();
    g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, 235);
    g.circle(-width / 2 + 23, 0, 5);
    g.fill();
    g.strokeColor = new Color(color.r, color.g, color.b, 92);
    g.lineWidth = 1.5;
    g.moveTo(-width / 2 + 35, -11);
    g.lineTo(-width / 2 + 35, 11);
    g.stroke();

    const labelNode = new Node('FxStatusBannerText');
    labelNode.layer = UI_2D;
    labelNode.parent = node;
    labelNode.addComponent(UITransform).setContentSize(width - 52, 38);
    labelNode.setPosition(14, 0, 0);
    const label = labelNode.addComponent(Label);
    label.string = text;
    label.fontSize = 18;
    label.lineHeight = 22;
    label.isBold = true;
    label.color = new Color(76, 67, 58, 255);
    label.horizontalAlign = 1;
    label.verticalAlign = 1;

    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.08, { opacity: 255 }, { easing: 'quadOut' })
      .delay(Math.max(0.24, duration))
      .to(0.18, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(node)
      .to(0.12, { position: new Vec3(0, y, 0), scale: new Vec3(1, 1, 1) }, { easing: 'backOut' })
      .delay(Math.max(0.24, duration))
      .by(0.18, { position: new Vec3(0, 12, 0) }, { easing: 'quadIn' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  /**
   * 边缘警报：只点亮四角与短刻度，保留危险氛围但不覆盖画面内容。
   */
  private edgeAlarm(color: Color, strength: number, duration: number): void {
    const { width, height } = this.effectBounds();
    const halfW = width / 2 - Math.max(20, width * 0.035);
    const halfH = height / 2 - Math.max(28, height * 0.035);
    const arm = Math.max(34, Math.min(74, width * 0.10));
    const node = new Node('FxEdgeAlarm');
    node.layer = UI_2D;
    node.addComponent(UITransform).setContentSize(width, height);
    this.root.addChild(node);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(color.r, color.g, color.b, 235);
    g.lineWidth = 5;
    const corners: Array<[number, number, number, number]> = [
      [-halfW, halfH, 1, -1],
      [halfW, halfH, -1, -1],
      [-halfW, -halfH, 1, 1],
      [halfW, -halfH, -1, 1],
    ];
    for (const [x, y, sx, sy] of corners) {
      g.moveTo(x, y + sy * arm);
      g.lineTo(x, y);
      g.lineTo(x + sx * arm, y);
    }
    g.stroke();
    g.strokeColor = new Color(color.r, color.g, color.b, 145);
    g.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      const x = i * width * 0.10;
      g.moveTo(x - 8, halfH);
      g.lineTo(x + 8, halfH);
      g.moveTo(x - 8, -halfH);
      g.lineTo(x + 8, -halfH);
    }
    g.stroke();

    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    const peak = Math.round(90 + Math.max(0, Math.min(1, strength)) * 120);
    tween(op)
      .to(0.08, { opacity: peak }, { easing: 'quadOut' })
      .to(0.10, { opacity: Math.round(peak * 0.42) }, { easing: 'quadInOut' })
      .to(0.10, { opacity: peak }, { easing: 'quadInOut' })
      .delay(Math.max(0, duration - 0.42))
      .to(0.14, { opacity: 0 }, { easing: 'quadIn' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  /**
   * Boss 结算扫描线：一条有方向的光带扫过任务区，比整屏闪红更能说明“正在检查”。
   */
  private scanSweep(color: Color, duration: number): void {
    const { width } = this.effectBounds();
    const slotPoints = this.slots.filter(n => n?.isValid).map(n => this.pointInRoot(n));
    const centerY = slotPoints.length > 0
      ? slotPoints.reduce((sum, p) => sum + p.y, 0) / slotPoints.length
      : 120;
    const node = new Node('FxInspectionSweep');
    node.layer = UI_2D;
    node.addComponent(UITransform).setContentSize(width, 80);
    node.setPosition(0, centerY + 110, 0);
    this.root.addChild(node);
    const g = node.addComponent(Graphics);
    const lineW = Math.min(width * 0.76, 760);
    g.strokeColor = new Color(color.r, color.g, color.b, 210);
    g.lineWidth = 3;
    g.moveTo(-lineW / 2, 0);
    g.lineTo(lineW / 2, 0);
    g.stroke();
    g.strokeColor = new Color(255, 252, 236, 210);
    g.lineWidth = 1.5;
    g.moveTo(-lineW / 2, 6);
    g.lineTo(lineW / 2, 6);
    g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, 220);
    g.moveTo(-8, -8);
    g.lineTo(0, -16);
    g.lineTo(8, -8);
    g.lineTo(0, 0);
    g.close();
    g.fill();
    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.06, { opacity: 225 })
      .delay(Math.max(0.08, duration - 0.18))
      .to(0.12, { opacity: 0 })
      .start();
    tween(node)
      .to(duration, { position: new Vec3(0, centerY - 120, 0) }, { easing: 'quadInOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  /** 传送带暂停时，三圈冷色轮廓从任务队列向外扩散。 */
  private beltFreezeWave(color: Color, duration: number): void {
    const points = this.slots.filter(n => n?.isValid).map(n => this.pointInRoot(n));
    if (points.length === 0) return;
    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const centerY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const width = Math.max(220, maxX - minX + 130);
    for (let i = 0; i < 3; i++) {
      const node = new Node(`FxFreezeWave${i}`);
      node.layer = UI_2D;
      node.addComponent(UITransform).setContentSize(width, 130);
      node.setPosition((minX + maxX) / 2, centerY, 0);
      node.setScale(0.92, 0.92, 1);
      this.root.addChild(node);
      const g = node.addComponent(Graphics);
      g.strokeColor = new Color(color.r, color.g, color.b, 195 - i * 32);
      g.lineWidth = 3 - i * 0.5;
      g.roundRect(-width / 2, -52, width, 104, 28);
      g.stroke();
      const op = node.addComponent(UIOpacity);
      op.opacity = 0;
      tween(op)
        .delay(i * 0.09)
        .to(0.08, { opacity: 190 - i * 30 }, { easing: 'quadOut' })
        .to(duration, { opacity: 0 }, { easing: 'quadIn' })
        .start();
      tween(node)
        .delay(i * 0.09)
        .to(duration + 0.08, { scale: new Vec3(1.08 + i * 0.05, 1.08 + i * 0.05, 1) }, { easing: 'quadOut' })
        .call(() => { if (node.isValid) node.destroy(); })
        .start();
    }
  }

  /** 奖励爆发：局部纸屑、短射线和圆环，适用于脱险、复活和拍马屁命中。 */
  private rewardBurst(origin: Vec3, color: Color, duration: number, strong = false): void {
    const node = new Node('FxRewardBurst');
    node.layer = UI_2D;
    node.addComponent(UITransform).setContentSize(180, 180);
    node.setPosition(origin.x, origin.y, 0);
    node.setScale(0.72, 0.72, 1);
    this.root.addChild(node);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(color.r, color.g, color.b, strong ? 235 : 190);
    g.lineWidth = strong ? 4 : 3;
    g.circle(0, 0, strong ? 30 : 24);
    g.stroke();
    const count = strong ? 14 : 10;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count;
      const inner = strong ? 39 : 34;
      const outer = strong ? 72 : 58;
      const x1 = Math.cos(a) * inner;
      const y1 = Math.sin(a) * inner;
      const x2 = Math.cos(a) * outer;
      const y2 = Math.sin(a) * outer;
      g.strokeColor = i % 2 === 0
        ? new Color(color.r, color.g, color.b, 220)
        : new Color(255, 252, 236, 220);
      g.lineWidth = i % 2 === 0 ? 3 : 2;
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.fillColor = new Color(color.r, color.g, color.b, 205);
      if (i % 3 === 0) {
        g.roundRect(x2 - 4, y2 - 3, 8, 6, 2);
        g.fill();
      } else {
        g.circle(x2, y2, 2.5);
        g.fill();
      }
    }
    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    tween(op)
      .to(0.05, { opacity: 235 }, { easing: 'quadOut' })
      .delay(Math.max(0.08, duration * 0.35))
      .to(duration * 0.55, { opacity: 0 }, { easing: 'quadIn' })
      .start();
    tween(node)
      .to(duration, {
        scale: new Vec3(strong ? 1.32 : 1.16, strong ? 1.32 : 1.16, 1),
        angle: strong ? 18 : 10,
      }, { easing: 'quadOut' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  /** Boss 临近时直接框住目标卡，玩家能看懂威胁来自哪里。 */
  private targetWarning(target: Node, color: Color, urgency: number): void {
    const ut = target.getComponent(UITransform);
    const width = Math.max(78, (ut?.width ?? 88) + 18);
    const height = Math.max(72, (ut?.height ?? 80) + 18);
    const node = new Node('FxTargetWarning');
    node.layer = UI_2D;
    node.parent = target;
    node.addComponent(UITransform).setContentSize(width, height);
    const g = node.addComponent(Graphics);
    g.strokeColor = new Color(color.r, color.g, color.b, 230);
    g.lineWidth = 3.5;
    const arm = Math.min(18, width * 0.22);
    const x = width / 2;
    const y = height / 2;
    const corners: Array<[number, number, number, number]> = [
      [-x, y, 1, -1], [x, y, -1, -1], [-x, -y, 1, 1], [x, -y, -1, 1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      g.moveTo(cx, cy + sy * arm);
      g.lineTo(cx, cy);
      g.lineTo(cx + sx * arm, cy);
    }
    g.stroke();
    g.fillColor = new Color(color.r, color.g, color.b, 230);
    g.moveTo(-7, y + 4);
    g.lineTo(0, y + 14);
    g.lineTo(7, y + 4);
    g.close();
    g.fill();
    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    node.setScale(1.12, 1.12, 1);
    const peak = Math.round(150 + urgency * 95);
    tween(op)
      .to(0.07, { opacity: peak })
      .to(0.10, { opacity: 70 })
      .to(0.08, { opacity: peak })
      .to(0.18, { opacity: 0 })
      .start();
    tween(node)
      .to(0.22, { scale: new Vec3(0.98, 0.98, 1) }, { easing: 'backOut' })
      .delay(0.18)
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }

  private comboBurst(combo: number, color: Color): void {
    const y = -46;
    this.statusBanner(`${combo} 连击 · 节奏拉满`, color, combo >= 5 ? 0.78 : 0.54, y);
    if (combo >= 3) this.rewardBurst(new Vec3(0, y, 0), color, combo >= 5 ? 0.62 : 0.44, combo >= 5);
  }

  private effectBounds(): { width: number; height: number } {
    const rootTransform = this.root.getComponent(UITransform);
    const parentTransform = this.root.parent?.getComponent(UITransform) ?? null;
    const width = rootTransform?.width || parentTransform?.width || 1080;
    const height = rootTransform?.height || parentTransform?.height || 1920;
    return {
      width: Math.max(390, width),
      height: Math.max(844, height),
    };
  }

  private resolveText(delta: number, state: string): string {
    if (delta > 0) return `替代 +${Math.round(delta)}`;
    if (delta < 0) return `替代 ${Math.round(delta)}`;
    if (state === 'inserted') return '拖延';
    if (state === 'idle') return '空转';
    return '归档';
  }

  private resolveColor(delta: number): Color {
    if (delta > 0) return new Color(226, 64, 54, 255);
    if (delta < 0) return new Color(78, 170, 74, 255);
    return new Color(122, 113, 101, 235);
  }

  /** 将节点坐标近似折算到 root 局部坐标；本项目 UI 节点无旋转/缩放嵌套。 */
  private pointInRoot(node: Node): Vec3 {
    let x = node.position.x;
    let y = node.position.y;
    let cur = node.parent;
    while (cur && cur !== this.root) {
      x += cur.position.x;
      y += cur.position.y;
      cur = cur.parent;
    }
    return new Vec3(x, y, 0);
  }

  /* ---------- 工具方法 ---------- */

  /** 浮动文字：从指定位置向上飘 50px 并淡出。 */
  private floatText(text: string, x: number, y: number, color: Color, duration: number, fontSize = 28): void {
    const node = new Node('FxText');
    node.layer = UI_2D;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(300, 40);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 6;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    node.setPosition(x, y, 0);
    this.root.addChild(node);

    const op = node.addComponent(UIOpacity);
    op.opacity = 255;
    tween(op)
      .delay(duration * 0.4)
      .to(duration * 0.6, { opacity: 0 })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();

    tween(node)
      .by(duration, { position: new Vec3(0, 50, 0) })
      .start();
  }

  /**
   * 屏幕震动：随机偏移 + 衰减 + 归位到基准。
   * 每次先停掉旧震动并归位基准，保证多次震动重叠（如 BossSpawned→BossInspection）
   * 时画面最终精确回到 rootBase，不会残留偏移。
   */
  private shake(intensity: number, duration: number): void {
    const base = this.rootBase;
    Tween.stopAllByTarget(this.root);
    this.root.setPosition(base.x, base.y, base.z);
    const t = tween(this.root);
    const steps = 5;
    const stepDur = duration / (steps + 1);
    for (let i = 0; i < steps; i++) {
      const decay = 1 - i / steps;
      const dx = (Math.random() - 0.5) * 2 * intensity * decay;
      const dy = (Math.random() - 0.5) * 2 * intensity * decay;
      t.by(stepDur, { position: new Vec3(dx, dy, 0) });
    }
    t.to(stepDur, { position: new Vec3(base.x, base.y, base.z) });
    t.start();
  }

}
