import { tween, Tween, Vec3, Node, Label, Color, UITransform, UIOpacity, Graphics } from 'cc';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, HitQuality, ApprovalZone } from '../core/types';

const UI_2D = 1 << 25; // 33554432

/**
 * 表现层动效系统 —— 订阅 core EventBus 事件，驱动 Cocos tween 动画。
 *
 * 纯演出层，不回写判定层（符合开发计划§2 架构纪律）。
 * 每局 startGame 时创建，换关时 dispose 释放旧订阅。
 *
 * 动效清单：
 *  - CardHit      → 挡位缩放打击 + 横向抖动 + Perfect 金字
 *  - CardResolved → 认可度旁浮动 +N/-N
 *  - ApprovalChanged → 认可度 Label 闪绿/红
 *  - ZoneChanged → 全屏区域色遮罩闪过
 *  - ComboUpdated → 连击数浮字
 *  - BossSpawned  → 屏震 + 红闪 + "BOSS 临检"
 *  - BossInspection → 重屏震 + 深红闪
 *  - KissUpFreeze → 蓝色遮罩持续冻结时长 + "冻结"
 *  - Revived      → 金色闪 + "复活 +8s"
 *  - GameOver     → 轻屏震
 *  - HuntChargeStart → 紫色脉冲 + "猎杀倒计时"
 *  - HuntChargeBreak → 绿色脉冲 + "脱险"
 *  - BossIncoming → 分级预警（tier 越近震/闪越急，≤2 格出"Boss逼近"浮字）
 *  - PropUnavailable → 灰色 "Miss" 浮字
 *  - PropCanceled   → 灰色 "取消" 浮字
 *  - AIHit        → 暖色闪 + "拍中/完美拍中"
 */
export class FxLayer {
  private unsubs: (() => void)[] = [];

  /** root 初始位置：屏震每次先归位到此基准，避免多次震动叠加导致画面残留偏移。 */
  private readonly rootBase: Vec3;
  /** approvalLabel 初始色：闪色恢复目标，避免连续触发时把"已改色"误记为基准。 */
  private approvalBaseColor: Color | null = null;

  /** 常驻全屏遮罩（复用单 node，零 GC；按需换色淡出，dispose 时销毁）。 */
  private overlayNode: Node | null = null;
  private overlayG: Graphics | null = null;
  private overlayOpacity: UIOpacity | null = null;

  constructor(
    private bus: EventBus,
    private root: Node,
    private slots: Node[],
    private approvalLabel: Label | null,
    private getSlotVisual: (slot: number) => Node | null = () => null,
  ) {
    this.rootBase = root.position.clone();
    if (approvalLabel && approvalLabel.isValid) this.approvalBaseColor = approvalLabel.color.clone();
    this.ensureOverlay();
    this.refreshSlotBases();
    this.bind();
  }

  private slotBases: Vec3[] = [];

  /** 布局层重排卡槽后刷新逻辑中心点；动效始终以这些基准点计算，避免连续 tween 漂移。 */
  refreshSlotBases(): void {
    this.slotBases = this.slots.map((slot) => slot?.isValid ? slot.position.clone() : new Vec3());
  }

  /** 释放所有事件订阅 + 清理常驻遮罩 + 停掉进行中的震动/闪色 tween（换关前调用）。 */
  dispose(): void {
    this.unsubs.forEach(fn => fn());
    this.unsubs = [];
    Tween.stopAllByTarget(this.root);
    if (this.approvalLabel?.isValid) Tween.stopAllByTarget(this.approvalLabel.node);
    if (this.overlayOpacity) Tween.stopAllByTarget(this.overlayOpacity);
    if (this.overlayNode?.isValid) this.overlayNode.destroy();
    this.overlayNode = null;
    this.overlayG = null;
    this.overlayOpacity = null;
  }

  /* ---------- 事件绑定 ---------- */

  private bind(): void {
    this.on('CardHit', ({ slot, quality, prop }) => this.fxCardHit(slot, quality, prop));
    this.on('CardResolved', ({ delta, card }) => this.fxCardResolved(delta, card));
    this.on('ApprovalChanged', ({ delta }) => this.fxApprovalChange(delta));
    this.on('ZoneChanged', ({ to }) => this.fxZoneChange(to));
    this.on('ComboUpdated', ({ combo }) => this.fxCombo(combo));
    this.on('BossSpawned', () => this.fxBossSpawned());
    this.on('BossInspection', () => this.fxBossInspection());
    this.on('KissUpFreeze', ({ durationSec }) => this.fxKissUpFreeze(durationSec));
    this.on('Revived', () => this.fxRevived());
    this.on('GameOver', () => this.fxGameOver());
    this.on('HuntChargeStart', () => this.fxHuntCharge());
    this.on('HuntChargeBreak', () => this.fxHuntBreak());
    this.on('BossIncoming', ({ tier }) => this.fxBossIncoming(tier));
    this.on('PropUnavailable', () => this.fxMiss());
    this.on('PropCanceled', () => this.fxCancel());
    this.on('AIHit', ({ quality }) => this.fxAIHit(quality));
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
    this.cardImpactBurst(origin, prop, quality);
    this.cardHitStamp(node, prop, quality);
    // Perfect 额外金字
    if (quality === 'perfect') {
      this.floatText('PERFECT!', origin.x, origin.y + 46, new Color(255, 204, 64), 0.58);
    }
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

  /* ---------- 卡牌结算（浮动 ±N） ---------- */

  private fxCardResolved(delta: number, card: GameEvents['CardResolved']['card']): void {
    const startNode = this.getSlotVisual(0) ?? this.slots[0] ?? this.approvalLabel?.node;
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
    label.color = delta > 0 ? new Color(100, 255, 100) : new Color(255, 80, 80);
    tween(label.node)
      .delay(0.2)
      .call(() => { if (label?.isValid) label.color = this.approvalBaseColor!; })
      .start();
  }

  /* ---------- 分区跨越（全屏色闪） ---------- */

  private fxZoneChange(to: ApprovalZone): void {
    // 猎杀闪屏从荧光紫改为深警示红棕，与危险红同族，避免引入第4种情绪色。
    const colors: Record<string, Color> = {
      hunt: new Color(150, 66, 58, 96),
      good: new Color(80, 200, 80, 60),
      ok: new Color(200, 180, 60, 50),
      danger: new Color(220, 60, 60, 100),
    };
    const c = colors[to];
    if (c) this.flashOverlay(c, 0.4);
  }

  /* ---------- 连击 ---------- */

  private fxCombo(combo: number): void {
    if (combo < 2) return;
    const color = combo >= 5 ? new Color(255, 100, 50) : new Color(255, 200, 50);
    this.floatText(`${combo} COMBO!`, 0, -60, color, 0.8);
  }

  /* ---------- Boss ---------- */

  private fxBossSpawned(): void {
    this.shake(6, 0.3);
    this.flashOverlay(new Color(200, 30, 30, 80), 0.3);
    this.floatText('BOSS 临检!', 0, 100, new Color(255, 60, 60), 1.2);
  }

  private fxBossInspection(): void {
    this.shake(12, 0.5);
    this.flashOverlay(new Color(255, 50, 50, 120), 0.5);
  }

  /* ---------- 拍马屁冻结 ---------- */

  private fxKissUpFreeze(durationSec: number): void {
    // 冻结提示用琥珀金（正向增益），不引入界面外的荧光蓝。
    this.flashOverlay(new Color(244, 172, 32, 56), Math.max(durationSec, 0.5));
    this.floatText('传送带暂停!', 0, 50, new Color(244, 172, 32), Math.max(durationSec, 0.8));
  }

  /* ---------- 复活 ---------- */

  private fxRevived(): void {
    this.flashOverlay(new Color(255, 215, 0, 120), 0.6);
    this.floatText('复活! +8s', 0, 50, new Color(255, 215, 0), 1.0);
  }

  /* ---------- 游戏结束 ---------- */

  private fxGameOver(): void {
    this.shake(4, 0.2);
  }

  /* ---------- 猎杀线 ---------- */

  private fxHuntCharge(): void {
    this.flashOverlay(new Color(150, 66, 58, 84), 0.8);
    this.floatText('猎杀倒计时!', 0, 80, new Color(226, 96, 80), 1.2);
  }

  /* ---------- 猎杀中断（脱险） ---------- */

  private fxHuntBreak(): void {
    this.flashOverlay(new Color(100, 255, 150, 70), 0.5);
    this.floatText('脱险!', 0, 60, new Color(120, 255, 160), 0.9);
  }

  /* ---------- Boss 分级预警（4格递进，越近越急） ---------- */

  private fxBossIncoming(tier: number): void {
    // tier: 4 最远 → 1 最近；越近 urgency 越高，震/闪越重
    const urgency = (5 - tier) / 4; // 4→0.25 … 1→1
    this.shake(2 + urgency * 6, 0.2 + urgency * 0.2);
    this.flashOverlay(new Color(255, 60, 60, 40 + urgency * 100), 0.3);
    if (tier <= 2) this.floatText('⚠ Boss 逼近!', 0, 60, new Color(255, 80, 80), 0.8);
  }

  /* ---------- Miss / 取消 / 拍马屁命中 ---------- */

  private fxMiss(): void {
    this.floatText('Miss', 0, -30, new Color(180, 180, 180), 0.6);
  }

  private fxCancel(): void {
    this.floatText('取消', 0, -30, new Color(150, 150, 150), 0.5);
  }

  private fxAIHit(quality: HitQuality): void {
    const perfect = quality === 'perfect';
    this.flashOverlay(new Color(255, 180, 200, perfect ? 100 : 50), 0.4);
    this.floatText(perfect ? '完美拍中!' : '拍中!', 0, 40, new Color(255, 200, 220), 0.8);
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
    if (delta > 0) this.flashOverlay(new Color(226, 64, 54, Math.min(80, 30 + Math.abs(delta) * 5)), 0.24);
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

  /**
   * 全屏色块遮罩：复用一个常驻 overlay node，换色重画 + 淡出。
   * 相比每次 new Node + Graphics，消除高频触发（Boss/冻结/分区跨越）时的 node 创建/GC 开销。
   */
  private flashOverlay(color: Color, duration: number): void {
    this.ensureOverlay();
    const g = this.overlayG!;
    const op = this.overlayOpacity!;
    Tween.stopAllByTarget(op);
    g.clear();
    g.fillColor = new Color(color.r, color.g, color.b, 255);
    g.rect(-1500, -1500, 3000, 3000);
    g.fill();
    op.opacity = color.a;
    tween(op)
      .delay(duration * 0.3)
      .to(duration * 0.7, { opacity: 0 })
      .start();
  }

  /** 懒创建/复用常驻全屏遮罩 node（默认 opacity=0 不可见）。 */
  private ensureOverlay(): void {
    if (this.overlayNode?.isValid) return;
    const node = new Node('FxOverlay');
    node.layer = UI_2D;
    node.setPosition(0, 0, 0);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(3000, 3000);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(255, 255, 255, 255);
    g.rect(-1500, -1500, 3000, 3000);
    g.fill();
    const op = node.addComponent(UIOpacity);
    op.opacity = 0;
    this.root.addChild(node);
    this.overlayNode = node;
    this.overlayG = g;
    this.overlayOpacity = op;
  }
}
