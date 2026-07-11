import { tween, Tween, Vec3, Node, Label, Color, UITransform, UIOpacity, Graphics, Mask, instantiate } from 'cc';
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

  /** 出队裁剪：直接在 Belt 节点上加 Mask（Belt 是场景树已有节点，渲染管线已初始化，Mask 可靠工作）。 */
  private beltMaskReady = false;

  constructor(
    private bus: EventBus,
    private root: Node,
    private slots: Node[],
    private approvalLabel: Label | null,
    private getShiftDurationSec: () => number = () => 0.46,
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
    this.ensureBeltMask();
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
    this.beltMaskReady = false;
  }

  /* ---------- 事件绑定 ---------- */

  private bind(): void {
    this.on('CardHit', ({ slot, quality }) => this.fxCardHit(slot, quality));
    this.on('CardResolved', ({ delta }) => this.fxCardResolved(delta));
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
    this.on('CardShifted', ({ outgoing }) => this.fxConveyorShift(!!outgoing));
  }

  private on<K extends keyof GameEvents>(name: K, fn: (p: GameEvents[K]) => void): void {
    this.unsubs.push(this.bus.on(name, fn));
  }

  /* ---------- 道具命中 ---------- */

  private fxCardHit(slot: number, quality: HitQuality): void {
    const node = this.slots[slot];
    if (!node || !node.isValid) return;

    const punch = quality === 'perfect' ? 1.5 : 1.25;
    // 缩放打击
    tween(node)
      .to(0.05, { scale: new Vec3(punch, punch, 1) })
      .to(0.1, { scale: new Vec3(1, 1, 1) })
      .start();
    // 横向抖动（+5, -10, +5 = 0 净位移）
    tween(node)
      .by(0.02, { position: new Vec3(5, 0, 0) })
      .by(0.02, { position: new Vec3(-10, 0, 0) })
      .by(0.02, { position: new Vec3(5, 0, 0) })
      .start();
    // Perfect 额外金字
    if (quality === 'perfect') {
      this.floatText('PERFECT!', node.position.x, node.position.y + 30, new Color(255, 215, 0), 0.7);
    }
  }

  /* ---------- 卡牌结算（浮动 ±N） ---------- */

  private fxCardResolved(delta: number): void {
    if (delta === 0 || !this.approvalLabel) return;
    const sign = delta > 0 ? '+' : '';
    const color = delta > 0 ? new Color(100, 255, 100) : new Color(255, 80, 80);
    const target = this.robotHeadPoint();
    this.flyResolvedCard(`${sign}${Math.round(delta)}`, color, target);
    this.floatText(`${sign}${Math.round(delta)}`, target.x, target.y + 18, color, 0.75);
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
    const colors: Record<string, Color> = {
      hunt: new Color(100, 80, 255, 90),
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
    this.flashOverlay(new Color(80, 150, 255, 70), Math.max(durationSec, 0.5));
    this.floatText('冻结!', 0, 50, new Color(100, 180, 255), Math.max(durationSec, 0.8));
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
    this.flashOverlay(new Color(100, 80, 255, 80), 0.8);
    this.floatText('猎杀倒计时!', 0, 80, new Color(180, 120, 255), 1.2);
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

  /** 传送带主视觉：整排卡片线性左移，入口/出口由 Belt 的矩形遮罩裁切。 */
  private fxConveyorShift(hasOutgoingCard: boolean): void {
    if (this.slots.length < 2) return;
    const gap = (this.slotBases[1]?.x ?? this.slots[1].position.x) - (this.slotBases[0]?.x ?? this.slots[0].position.x);
    if (!Number.isFinite(gap) || Math.abs(gap) < 1) return;
    const duration = Math.max(0.28, this.getShiftDurationSec() * 0.98);
    if (hasOutgoingCard) this.spawnOutgoingGhost(gap);
    this.slots.forEach((slot, index) => {
      if (!slot?.isValid) return;
      Tween.stopAllByTarget(slot);
      const base = this.slotBases[index]?.clone() ?? slot.position.clone();
      slot.setPosition(base.x + gap, base.y, base.z);
      slot.setScale(new Vec3(1, 1, 1));
      const opacity = slot.getComponent(UIOpacity) ?? slot.addComponent(UIOpacity);
      Tween.stopAllByTarget(opacity);
      opacity.opacity = 255;
      tween(slot).to(duration, { position: base }, { easing: 'linear' }).start();
    });
  }

  /**
   * 旧处理区卡片在队列换档前克隆一份，挂到 Belt 下向左滑出。
   *
   * Belt 节点已加 Mask（见 ensureBeltMask），ghost 滑出 Belt 左边缘时被 Mask
   * 裁剪，视觉上呈现 完整 → 2/3 → 1/2 → 1/3 → 完全离开 的"被显示器吞没"效果。
   */
  private spawnOutgoingGhost(gap: number): void {
    const head = this.slots[0];
    const belt = head?.parent;
    if (!head?.isValid || !belt?.isValid) return;

    const base = this.slotBases[0]?.clone() ?? head.position.clone();
    const duration = Math.max(0.28, this.getShiftDurationSec() * 0.98);
    const headUt = head.getComponent(UITransform);
    const cardW = headUt?.width ?? Math.abs(gap);
    if (cardW <= 0) return;

    const ghost = instantiate(head);
    ghost.name = 'OutgoingCardGhost';
    ghost.layer = head.layer;
    ghost.parent = belt;
    ghost.setSiblingIndex(belt.children.length - 1); // 顶层
    ghost.setPosition(base);
    ghost.setScale(new Vec3(1, 1, 1));
    const opacity = ghost.getComponent(UIOpacity) ?? ghost.addComponent(UIOpacity);
    opacity.opacity = 255;

    // 滑出距离 = 卡片宽度 × 1.1（完全离开 Belt 裁剪区 + 10% 余量）
    const travel = cardW * 1.1;
    tween(ghost)
      .to(duration, { position: new Vec3(base.x - travel, base.y, base.z) }, { easing: 'linear' })
      .call(() => { if (ghost.isValid) ghost.destroy(); })
      .start();
  }

  /**
   * 在 Belt 节点上加 Mask（GRAPHICS_STENCIL），裁剪区域 = 传送带范围 + 右侧多一格 gap
   * （给 shift 动画中右移的卡片留空间）。Belt 是场景树已有节点，渲染管线已初始化，
   * Mask 在这里能可靠工作（动态创建的新节点上 Mask 经常不初始化模板缓冲）。
   */
  private ensureBeltMask(): void {
    if (this.beltMaskReady) return;
    const belt = this.slots[0]?.parent;
    if (!belt?.isValid || this.slots.length < 1) return;

    const first = this.slots[0];
    const last = this.slots[this.slots.length - 1];
    const firstUt = first?.getComponent(UITransform);
    const lastUt = last?.getComponent(UITransform);
    if (!first?.isValid || !last?.isValid || !firstUt || !lastUt) return;

    // 计算裁剪区域：从 slot0 左边缘到 slotN 右边缘 + 一格 gap（shift 动画余量）
    const gap = this.slots.length > 1
      ? Math.abs(this.slots[1].position.x - this.slots[0].position.x)
      : firstUt.width + 8;
    const left = first.position.x - firstUt.width / 2;
    const right = last.position.x + lastUt.width / 2 + gap;
    const w = right - left;
    const h = Math.max(firstUt.height, lastUt.height) + 4;

    // 确保 Belt 有 UITransform（Mask 依赖 contentSize 做裁剪矩形）
    let ut = belt.getComponent(UITransform);
    if (!ut) ut = belt.addComponent(UITransform);
    ut.setContentSize(w, h);
    // Belt 的 anchor 默认 (0.5, 0.5)，rect 居中于 Belt position。
    // slots 在 layoutBeltSlots 中围绕 X=0 对称排布，所以 Belt position 的 X 应为 0
    // 或接近 0。这里不改动 Belt position，只设 contentSize。

    // GRAPHICS_STENCIL：Graphics 画矩形 = 可见区域；矩形外被裁剪
    let g = belt.getComponent(Graphics);
    if (!g) g = belt.addComponent(Graphics);
    g.clear();
    g.rect(-w / 2, -h / 2, w, h);
    g.fill();

    let mask = belt.getComponent(Mask);
    if (!mask) {
      mask = belt.addComponent(Mask);
      mask.type = Mask.Type.GRAPHICS_STENCIL;
    }

    this.beltMaskReady = true;
  }

  private flyResolvedCard(text: string, color: Color, target: Vec3): void {
    const startNode = this.slots[0] ?? this.approvalLabel?.node;
    if (!startNode?.isValid) return;
    const start = this.pointInRoot(startNode);
    const node = new Node('ResolvedCardFly');
    node.layer = UI_2D;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(66, 46);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(250, 246, 236, 255);
    g.strokeColor = color;
    g.lineWidth = 3;
    g.roundRect(-33, -23, 66, 46, 10);
    g.fill();
    g.stroke();
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = 24;
    label.lineHeight = 28;
    label.isBold = true;
    label.color = color;
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    node.setPosition(start.x, start.y, 0);
    this.root.addChild(node);
    const op = node.addComponent(UIOpacity);
    op.opacity = 255;
    const peak = new Vec3((start.x + target.x) / 2, Math.max(start.y, target.y) + 70, 0);
    tween(node)
      .to(0.18, { position: peak, scale: new Vec3(0.82, 0.82, 1) }, { easing: 'quadOut' })
      .to(0.26, { position: target, scale: new Vec3(0.38, 0.38, 1) }, { easing: 'quadIn' })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
    tween(op).delay(0.28).to(0.16, { opacity: 0 }, { easing: 'quadIn' }).start();
  }

  private robotHeadPoint(): Vec3 {
    const char = this.root.getChildByName('Char');
    if (char?.isValid) {
      const ut = char.getComponent(UITransform);
      return new Vec3(char.position.x, char.position.y + (ut?.height ?? 180) * 0.42, 0);
    }
    const p = this.approvalLabel?.node.position ?? new Vec3(0, 0, 0);
    return new Vec3(p.x + 120, p.y, 0);
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
  private floatText(text: string, x: number, y: number, color: Color, duration: number): void {
    const node = new Node('FxText');
    node.layer = UI_2D;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(300, 40);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = 28;
    label.lineHeight = 34;
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
