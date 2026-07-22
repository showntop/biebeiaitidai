import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens, alphaColor, mixColor } from './UiTokens';

/**
 * 认可度仪表：一块贴桌沿的小纸质铭牌。
 *
 * 信息降噪原则（小游戏 HUD 语言）：
 *  - 不显示阈值刻度数字：绿/黄/红分区颜色本身就是信息；
 *  - 不显示事件控制台：只显示短战报提示，重反馈仍走 FxLayer 飘字；
 *  - 危险态只保留一个抖动徽章，不再叠加外圈脉冲描边。
 * 底部保留一行提示条；教学使用蓝色强调，普通战报仍保持低视觉权重。
 */
export class ApprovalGaugeView {
  private readonly frame: Graphics;
  private readonly dynamic: Graphics;
  private readonly value: Label;
  private readonly zone: Label;
  private readonly hint: Label;
  private readonly delta: Label;
  private barW = 0;
  private barH = 0;
  private barY = 0;
  private zoneBaseX = 0;
  private zoneBaseY = 0;
  private displayedApproval = Number.NaN;
  private targetApproval = Number.NaN;
  private lastElapsed = Number.NaN;
  private lastZone = '';
  private deltaText = '';
  private deltaUntil = 0;
  private zoneFlashUntil = 0;
  private lastDynamicSignature = '';

  constructor(private readonly root: Node) {
    this.frame = root.getComponent(Graphics) ?? root.addComponent(Graphics);
    this.dynamic = this.ensureGraphics('Dynamic');
    this.value = this.ensureLabel('ApprovalValue');
    this.zone = this.ensureLabel('Zone');
    this.hint = this.ensureLabel('Hint');
    this.delta = this.ensureLabel('Delta');
    // 清理旧版本残留的刻度/事件节点（热更或重复布局时避免叠影）
    ['Scale', 'EventTag', 'Event'].forEach((name) => {
      const stale = root.getChildByName(name);
      if (stale) stale.destroy();
    });
  }

  private valueBaseX = 0;

  layout(width: number, height: number): void {
    this.lastDynamicSignature = '';
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.barW = width - 60;
    this.barH = Math.min(22, Math.max(16, height * 0.18));
    this.barY = -height * 0.10;

    const rowY = height * 0.22;
    this.valueBaseX = -this.barW / 2;
    this.zoneBaseX = this.barW / 2 - 40;
    this.zoneBaseY = rowY;

    this.place(this.value, this.valueBaseX + width * 0.22, rowY, width * 0.46, 38);
    this.place(this.zone, this.zoneBaseX, this.zoneBaseY, 78, 30);
    this.place(this.hint, 0, -height / 2 + 16, this.barW, 28);
    this.place(this.delta, this.valueBaseX + width * 0.35, rowY + 28, 74, 26);

    UiPainter.label(this.value, Math.min(30, Math.max(22, width * 0.040)), UiTokens.color.inkDeep, true);
    UiPainter.label(this.zone, UiTokens.type.caption, UiTokens.color.inkDeep, true);
    UiPainter.label(this.hint, 19, alphaColor(UiTokens.color.muted, 190), true);
    UiPainter.label(this.delta, UiTokens.type.caption, UiTokens.color.danger, true);
    this.value.horizontalAlign = 0;

    this.frame.clear();
    const g = this.frame;
    const panelR = Math.min(44, height * 0.42);
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 34);
    g.roundRect(-width / 2 + 5, -height / 2 - 6, width - 10, height, panelR);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 250);
    g.strokeColor = new Color(226, 216, 198, 230);
    g.lineWidth = 1.5;
    g.roundRect(-width / 2, -height / 2, width, height, panelR);
    g.fill(); g.stroke();

    const y = this.barY;
    const r = this.barH / 2;
    g.fillColor = new Color(226, 218, 204, 255);
    g.roundRect(-this.barW / 2, y - this.barH / 2, this.barW, this.barH, r);
    g.fill();

    const segs = [
      { x: 0, w: 0.18, c: UiTokens.color.gold },
      { x: 0.18, w: 0.31, c: UiTokens.color.good },
      { x: 0.49, w: 0.20, c: UiTokens.color.gold },
      { x: 0.69, w: 0.31, c: UiTokens.color.danger },
    ];
    segs.forEach((seg, i) => {
      const sx = -this.barW / 2 + this.barW * seg.x;
      const sw = this.barW * seg.w;
      g.fillColor = alphaColor(seg.c, 68);
      g.roundRect(sx, y - this.barH / 2, sw + (i < segs.length - 1 ? 2 : 0), this.barH, i === 0 || i === segs.length - 1 ? r : 2);
      g.fill();
    });

    this.dynamic.node.getComponent(UITransform)?.setContentSize(width, height);
    this.dynamic.node.setPosition(0, 0, 0);
  }

  update(
    approval: number,
    zone: string,
    hintText: string,
    elapsed: number,
    remainingSec = 0,
    huntProgress = 0,
    huntThreshold = 18,
    huntHoldSec = 2,
    objectiveText = '',
  ): void {
    const copy: Record<string, string> = { hunt: '反杀!', good: '良好', ok: '一般', danger: '危险!' };
    const colors: Record<string, Readonly<Color>> = {
      hunt: UiTokens.color.gold,
      good: UiTokens.color.good,
      ok: UiTokens.color.gold,
      danger: UiTokens.color.danger,
    };
    if (Number.isNaN(this.displayedApproval)) {
      this.displayedApproval = approval;
      this.targetApproval = approval;
      this.lastElapsed = elapsed;
      this.lastZone = zone;
    }
    if (approval !== this.targetApproval) {
      const delta = approval - this.targetApproval;
      this.deltaText = delta > 0 ? `+${delta}` : `${delta}`;
      this.deltaUntil = elapsed + 0.72;
      this.targetApproval = approval;
    }
    if (zone !== this.lastZone) {
      this.lastZone = zone;
      this.zoneFlashUntil = elapsed + 0.64;
    }
    const dt = Number.isFinite(this.lastElapsed) ? Math.max(0, Math.min(0.1, elapsed - this.lastElapsed)) : 0;
    this.lastElapsed = elapsed;
    const lerp = Math.min(1, dt * 10);
    this.displayedApproval += (this.targetApproval - this.displayedApproval) * lerp;
    if (Math.abs(this.targetApproval - this.displayedApproval) < 0.35) this.displayedApproval = this.targetApproval;
    const shownApproval = Math.round(this.displayedApproval);
    const pct = Math.max(0, Math.min(1, this.displayedApproval / 100));
    const zoneColor = colors[zone] ?? UiTokens.color.gold;
    const danger = zone === 'danger';
    this.value.string = `认可度  ${shownApproval}`;
    this.zone.string = copy[zone] ?? zone;
    this.zone.color = zoneColor;
    const eventHint = hintText.trim();
    const teaching = eventHint.startsWith('教学 ·');
    const huntRemain = Math.max(0, huntHoldSec * (1 - huntProgress));
    const routeHint = huntProgress > 0
      ? `反杀锁定 ${Math.round(huntProgress * 100)}% · 再稳 ${huntRemain.toFixed(1)}s`
      : `守住 ${Math.ceil(remainingSec)}s  ｜  压到 ≤${huntThreshold} 可提前反杀`;
    const objectiveHint = objectiveText.trim();
    const hint = eventHint ? (teaching ? eventHint : `战报 · ${eventHint}`) : huntProgress > 0 ? routeHint : objectiveHint ? `目标 · ${objectiveHint}` : routeHint;
    this.hint.string = hint;
    this.hint.node.active = true;
    this.hint.color = teaching
      ? UiTokens.color.blue
      : huntProgress > 0 && !eventHint
      ? UiTokens.color.gold
      : objectiveHint && !eventHint ? alphaColor(UiTokens.color.blue, 220) : alphaColor(UiTokens.color.muted, 190);
    this.delta.node.active = elapsed < this.deltaUntil && !!this.deltaText;

    const shakeX = danger ? Math.sin(elapsed * 18) * 1.4 : 0;
    this.zone.node.setPosition(this.zoneBaseX + shakeX, this.zoneBaseY, 0);

    const animating = this.displayedApproval !== this.targetApproval
      || elapsed < this.deltaUntil
      || elapsed < this.zoneFlashUntil
      || danger
      || !!eventHint
      || huntProgress > 0;
    const paintBucket = animating ? Math.floor(elapsed * 15) : 0;
    const dynamicSignature = [
      shownApproval,
      zone,
      hint,
      Math.round(huntProgress * 100),
      Math.ceil(remainingSec),
      objectiveHint,
      this.delta.node.active ? this.deltaText : '',
      paintBucket,
      Math.round(this.barW),
      Math.round(this.barH),
    ].join('|');
    if (dynamicSignature === this.lastDynamicSignature) return;
    this.lastDynamicSignature = dynamicSignature;

    const g = this.dynamic;
    g.clear();

    const badgeW = 76;
    const badgeH = 30;
    const bx = this.zoneBaseX + shakeX;
    const zoneFlash = Math.max(0, this.zoneFlashUntil - elapsed);
    g.fillColor = danger
      ? alphaColor(UiTokens.color.danger, 42 + zoneFlash * 80)
      : new Color(253, 234, 195, 255);
    g.roundRect(bx - badgeW / 2, this.zoneBaseY - badgeH / 2, badgeW, badgeH, badgeH / 2);
    g.fill();

    const inset = 0;
    const innerH = this.barH - inset * 2;
    const trackInnerW = this.barW - inset * 2;
    const fillW = trackInnerW * pct;
    const left = -this.barW / 2 + inset;
    if (fillW > 0) {
      g.fillColor = zoneColor;
      g.roundRect(left, this.barY - innerH / 2, Math.max(innerH, fillW), innerH, innerH / 2);
      g.fill();
      g.fillColor = alphaColor(Color.WHITE, 58);
      g.roundRect(left + 4, this.barY + innerH * 0.10, Math.max(0, fillW - 8), innerH * 0.30, innerH * 0.15);
      g.fill();
    }

    // 反杀线与连续维持进度：细轨道位于主仪表下方，不新增占屏 UI。
    const huntW = trackInnerW * Math.max(0, Math.min(1, huntThreshold / 100));
    const huntRailY = this.barY - innerH / 2 - 4;
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 35);
    g.roundRect(left, huntRailY - 1.5, huntW, 3, 1.5);
    g.fill();
    if (huntProgress > 0) {
      g.fillColor = UiTokens.color.gold;
      g.roundRect(left, huntRailY - 2, Math.max(4, huntW * huntProgress), 4, 2);
      g.fill();
    }
    const thresholdX = left + huntW;
    g.strokeColor = alphaColor(UiTokens.color.inkDeep, 120);
    g.lineWidth = 1.5;
    g.moveTo(thresholdX, this.barY - innerH / 2 - 5);
    g.lineTo(thresholdX, this.barY + innerH / 2 + 3);
    g.stroke();

    if (elapsed < this.deltaUntil && this.deltaText) {
      const remain = this.deltaUntil - elapsed;
      const positive = this.deltaText.startsWith('+');
      const badgeText = this.deltaText;
      const chipW = Math.max(42, 22 + badgeText.length * 11);
      const chipH = 24;
      const dx = this.valueBaseX + this.root.getComponent(UITransform)!.width * 0.35;
      const dy = this.zoneBaseY + 26 + (0.72 - remain) * 12;
      const dc = positive ? UiTokens.color.danger : UiTokens.color.good;
      this.delta.string = badgeText;
      this.delta.color = dc;
      this.delta.node.setPosition(dx, dy, 0);
      this.delta.node.getComponent(UITransform)?.setContentSize(chipW, chipH);
      g.fillColor = alphaColor(UiTokens.color.paper, 230);
      g.roundRect(dx - chipW / 2, dy - chipH / 2, chipW, chipH, chipH / 2);
      g.fill();
      g.strokeColor = alphaColor(dc, Math.round(120 + remain * 80));
      g.lineWidth = 1.8;
      g.roundRect(dx - chipW / 2, dy - chipH / 2, chipW, chipH, chipH / 2);
      g.stroke();
    }

    if (eventHint || huntProgress > 0) {
      const pulse = 0.88 + Math.sin(elapsed * 9) * 0.08;
      const hintW = Math.min(this.barW, 560);
      const hintH = 28;
      const hintY = -this.root.getComponent(UITransform)!.height / 2 + 16;
      g.fillColor = alphaColor(UiTokens.color.paper, 220);
      g.roundRect(-hintW / 2, hintY - hintH / 2, hintW, hintH, hintH / 2);
      g.fill();
      g.strokeColor = alphaColor(teaching ? UiTokens.color.blue : zoneColor, 80 + pulse * 45);
      g.lineWidth = 1.5;
      g.roundRect(-hintW / 2, hintY - hintH / 2, hintW, hintH, hintH / 2);
      g.stroke();
    }
  }

  /** 结算瞬间同步到规则层最终值，避免插值动画停在 98/99 与战报 100 不一致。 */
  snap(approval: number, zone: string, hintText: string, elapsed: number): void {
    this.displayedApproval = approval;
    this.targetApproval = approval;
    this.lastElapsed = elapsed;
    this.lastDynamicSignature = '';
    this.update(approval, zone, hintText, elapsed, 0, 0);
  }

  private ensureGraphics(name: string): Graphics {
    const node = this.root.getChildByName(name) ?? new Node(name);
    if (!node.parent) node.parent = this.root;
    node.layer = this.root.layer;
    if (!node.getComponent(UITransform)) node.addComponent(UITransform);
    return node.getComponent(Graphics) ?? node.addComponent(Graphics);
  }

  private ensureLabel(name: string): Label {
    const node = this.root.getChildByName(name) ?? new Node(name);
    if (!node.parent) node.parent = this.root;
    node.layer = this.root.layer;
    if (!node.getComponent(UITransform)) node.addComponent(UITransform);
    const label = node.getComponent(Label) ?? node.addComponent(Label);
    label.horizontalAlign = 1;
    label.verticalAlign = 1;
    label.overflow = Label.Overflow.SHRINK;
    return label;
  }

  private place(label: Label, x: number, y: number, width: number, height: number): void {
    label.node.getComponent(UITransform)?.setContentSize(width, height);
    label.node.setPosition(x, y, 0);
  }
}
