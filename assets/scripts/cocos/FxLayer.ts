import { tween, Vec3, Node, Label, Color, UITransform, UIOpacity, Graphics } from 'cc';
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
 */
export class FxLayer {
  private unsubs: (() => void)[] = [];

  constructor(
    private bus: EventBus,
    private root: Node,
    private slots: Node[],
    private approvalLabel: Label | null,
  ) {
    this.bind();
  }

  /** 释放所有事件订阅（换关前调用）。 */
  dispose(): void {
    this.unsubs.forEach(fn => fn());
    this.unsubs = [];
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
    const p = this.approvalLabel.node.position;
    this.floatText(`${sign}${Math.round(delta)}`, p.x + 120, p.y, color, 0.7);
  }

  /* ---------- 认可度变化（Label 闪色） ---------- */

  private fxApprovalChange(delta: number): void {
    const label = this.approvalLabel;
    if (!label || !label.isValid) return;
    const orig = label.color.clone();
    label.color = delta > 0 ? new Color(100, 255, 100) : new Color(255, 80, 80);
    tween(label.node)
      .delay(0.2)
      .call(() => { if (label?.isValid) label.color = orig; })
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

  /** 屏幕震动：随机偏移 + 衰减 + 归位。 */
  private shake(intensity: number, duration: number): void {
    const ox = this.root.position.x;
    const oy = this.root.position.y;
    const t = tween(this.root);
    const steps = 5;
    const stepDur = duration / (steps + 1);
    for (let i = 0; i < steps; i++) {
      const decay = 1 - i / steps;
      const dx = (Math.random() - 0.5) * 2 * intensity * decay;
      const dy = (Math.random() - 0.5) * 2 * intensity * decay;
      t.by(stepDur, { position: new Vec3(dx, dy, 0) });
    }
    t.to(stepDur, { position: new Vec3(ox, oy, 0) });
    t.start();
  }

  /** 全屏色块遮罩：先保持再淡出。 */
  private flashOverlay(color: Color, duration: number): void {
    const node = new Node('FxOverlay');
    node.layer = UI_2D;
    node.setPosition(0, 0, 0);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(3000, 3000);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(color.r, color.g, color.b, 255);
    g.rect(-1500, -1500, 3000, 3000);
    g.fill();
    this.root.addChild(node);

    const op = node.addComponent(UIOpacity);
    op.opacity = color.a;
    tween(op)
      .delay(duration * 0.3)
      .to(duration * 0.7, { opacity: 0 })
      .call(() => { if (node.isValid) node.destroy(); })
      .start();
  }
}
