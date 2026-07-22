import { Color, Graphics, Label, Node, tween, Tween, UIOpacity, UITransform, Vec3 } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens } from './UiTokens';

export interface PropDockLayoutInput {
  parent: Node;
  layer: number;
  propButtons: Node;
  targetCount: number;
  viewWidth: number;
  viewHeight: number;
  horizontalPadding: number;
  usedW: number;
  btnW: number;
  btnH: number;
  gap: number;
  startX: number;
  buttonY: number;
  choosing: boolean;
  aimingIndex: number;
  playing: boolean;
}

export interface PropDockLayoutResult {
  node: Node;
  active: boolean;
  dockW: number;
  dockH: number;
  dockY: number;
}

/**
 * 道具长按后的投掷滑轨纯视图。
 *
 * 静态背景只在布局变化时绘制；拖动过程只更新少量节点 transform，
 * 切换目标时才重画刻度，避免 TOUCH_MOVE 高频 Graphics.clear。
 */
export class PropDockView {
  private root: Node | null = null;
  private hintLabel: Label | null = null;
  private ticksG: Graphics | null = null;
  private haloNode: Node | null = null;
  private haloG: Graphics | null = null;
  private rootOpacity: UIOpacity | null = null;
  private active = false;
  private dockW = 0;
  private dockH = 0;
  private targetCount = 1;
  private selectedSlot = -1;
  private perfectReady = false;
  private targetValid = true;
  private cancelArmed = false;

  layout(input: PropDockLayoutInput): PropDockLayoutResult {
    const root = this.ensure(input.parent, input.layer);
    const dockLayout = UiTokens.layout.actionDock;
    const dockW = Math.min(input.usedW + dockLayout.sidePadding, input.viewWidth - input.horizontalPadding * 2 + dockLayout.extraWidth);
    const lowerHudGap = Math.max(dockLayout.minHudGap, input.viewHeight * dockLayout.hudGapRatio);
    // 操作轨放到常驻按钮上方：玩家始终知道自己从哪个道具进入，也能随时看到其余库存/CD。
    const dockBottom = input.buttonY + input.btnH / 2 + Math.max(8, input.btnH * dockLayout.bottomGapRatio);
    const dockTopLimit = dockBottom + lowerHudGap + dockLayout.maxHeight;
    const dockAvailableH = Math.max(dockLayout.minAvailableHeight, dockTopLimit - dockBottom);
    const dockH = input.choosing
      ? Math.max(dockLayout.minHeight, Math.min(dockLayout.maxHeight, dockAvailableH))
      : input.btnH + dockLayout.idleExtraHeight;
    const dockY = input.choosing ? dockBottom + dockH / 2 : input.buttonY - 4;
    const active = input.choosing && input.playing;

    this.dockW = dockW;
    this.dockH = dockH;
    this.targetCount = Math.max(1, input.targetCount);
    this.selectedSlot = -1;
    this.perfectReady = false;
    this.targetValid = true;
    this.cancelArmed = false;

    root.getComponent(UITransform)!.setContentSize(dockW, dockH);
    root.setPosition(0, dockY, 0);
    root.setSiblingIndex(Math.max(0, input.propButtons.getSiblingIndex() - 1));
    this.paintDock(root.getComponent(Graphics)!, dockW, dockH);
    this.layoutHint(dockW, dockH, active);
    this.paintTicks(-1);
    this.setActive(active);

    return { node: root, active, dockW, dockH, dockY };
  }

  updateInteraction(slot: number, strength: number, velocity: number, perfectReady: boolean, targetValid: boolean, cancelArmed = false): void {
    if (!this.active || !this.root?.isValid) return;
    const dockLayout = UiTokens.layout.actionDock;
    const trackY = -this.dockH * dockLayout.trackYRatio;
    const left = -this.dockW / 2 + dockLayout.tickInset;
    const right = this.dockW / 2 - dockLayout.tickInset;
    const markerX = this.targetCount === 1
      ? 0
      : left + Math.max(0, Math.min(this.targetCount - 1, slot)) * (right - left) / (this.targetCount - 1);

    if (slot !== this.selectedSlot || perfectReady !== this.perfectReady || targetValid !== this.targetValid || cancelArmed !== this.cancelArmed) {
      const slotChanged = slot !== this.selectedSlot;
      this.selectedSlot = slot;
      this.perfectReady = perfectReady;
      this.targetValid = targetValid;
      this.cancelArmed = cancelArmed;
      this.paintTicks(slot);
      this.paintHalo(perfectReady, targetValid, cancelArmed);
      if (this.hintLabel) {
        this.hintLabel.string = cancelArmed
          ? '已收回 · 松手取消（不消耗）'
          : !targetValid
          ? `任务 ${slot + 1} 不适用 · 换个目标`
          : perfectReady
          ? `精准锁定任务 ${slot + 1} · 松手 PERFECT`
          : `已锁定任务 ${slot + 1} · 稳住准星`;
        this.hintLabel.color = cancelArmed
          ? UiTokens.color.danger
          : !targetValid
          ? UiTokens.color.muted
          : perfectReady ? UiTokens.color.gold : new Color(82, 70, 58, 235);
      }
      if (slotChanged && this.haloNode?.isValid) {
        Tween.stopAllByTarget(this.haloNode);
        this.haloNode.setScale(0.82, 0.82, 1);
        tween(this.haloNode)
          .to(0.11, { scale: new Vec3(1.12, 1.12, 1) }, { easing: 'backOut' })
          .to(0.08, { scale: new Vec3(1, 1, 1) }, { easing: 'quadInOut' })
          .start();
      }
    }

    if (this.haloNode?.isValid) {
      this.haloNode.setPosition(markerX, trackY, 0);
      const opacity = this.haloNode.getComponent(UIOpacity);
      if (opacity) opacity.opacity = Math.round(150 + strength * 38 + velocity * 22);
    }
  }

  private ensure(parent: Node, layer: number): Node {
    if (this.root?.isValid) return this.root;
    this.root = new Node('ActionDock');
    this.root.layer = layer;
    this.root.parent = parent;
    this.root.addComponent(UITransform);
    this.root.addComponent(Graphics);
    this.rootOpacity = this.root.addComponent(UIOpacity);

    const ticks = new Node('ActionDockTicks');
    ticks.layer = layer;
    ticks.parent = this.root;
    ticks.addComponent(UITransform);
    this.ticksG = ticks.addComponent(Graphics);

    const halo = new Node('ActionDockHalo');
    halo.layer = layer;
    halo.parent = this.root;
    halo.addComponent(UITransform).setContentSize(66, 66);
    this.haloG = halo.addComponent(Graphics);
    this.paintHalo(false, true);
    halo.addComponent(UIOpacity).opacity = 170;
    this.haloNode = halo;

    const hint = new Node('ActionDockHint');
    hint.layer = layer;
    hint.parent = this.root;
    hint.addComponent(UITransform);
    this.hintLabel = hint.addComponent(Label);
    this.hintLabel.horizontalAlign = 1;
    this.hintLabel.verticalAlign = 1;
    this.hintLabel.enableWrapText = false;
    return this.root;
  }

  private setActive(active: boolean): void {
    if (!this.root || !this.rootOpacity) return;
    if (!active) {
      Tween.stopAllByTarget(this.root);
      Tween.stopAllByTarget(this.rootOpacity);
      this.root.active = false;
      this.active = false;
      return;
    }
    this.root.active = true;
    if (!this.active) {
      this.rootOpacity.opacity = 0;
      this.root.setScale(0.97, 0.90, 1);
      tween(this.rootOpacity).to(0.10, { opacity: 255 }, { easing: 'quadOut' }).start();
      tween(this.root)
        .to(0.14, { scale: new Vec3(1.015, 1.02, 1) }, { easing: 'backOut' })
        .to(0.07, { scale: new Vec3(1, 1, 1) }, { easing: 'quadInOut' })
        .start();
    }
    this.active = true;
  }

  private layoutHint(dockW: number, dockH: number, active: boolean): void {
    if (!this.hintLabel) return;
    const dockLayout = UiTokens.layout.actionDock;
    this.hintLabel.node.active = active;
    this.hintLabel.string = '左右选任务 · 松手投出 · 上甩更爽';
    UiPainter.label(this.hintLabel, UiTokens.type.dockHint, new Color(82, 70, 58, 235), true);
    this.hintLabel.node.getComponent(UITransform)?.setContentSize(dockW - 52, dockLayout.hintHeight);
    this.hintLabel.node.setPosition(0, dockH / 2 - dockLayout.hintTopOffset, 0);
  }

  private paintDock(g: Graphics, dockW: number, dockH: number): void {
    const dockLayout = UiTokens.layout.actionDock;
    const radius = Math.min(dockLayout.radiusMax, Math.max(dockLayout.radiusMin, dockH * 0.16));
    const trackY = -dockH * dockLayout.trackYRatio;
    const trackX = -dockW / 2 + dockLayout.trackSideInset;
    const trackW = dockW - dockLayout.trackSideInset * 2;

    g.clear();
    g.fillColor = new Color(54, 48, 42, 42);
    g.roundRect(-dockW / 2 + 5, -dockH / 2 - 6, dockW - 10, dockH, radius);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 250);
    g.strokeColor = new Color(126, 94, 68, 224);
    g.lineWidth = 3;
    g.roundRect(-dockW / 2, -dockH / 2, dockW, dockH, radius);
    g.fill();
    g.stroke();

    g.fillColor = new Color(238, 229, 215, 245);
    g.strokeColor = new Color(168, 124, 88, 92);
    g.lineWidth = 1.5;
    g.roundRect(trackX, trackY - dockLayout.trackHeight / 2, trackW, dockLayout.trackHeight, dockLayout.trackHeight / 2);
    g.fill();
    g.stroke();
    g.fillColor = new Color(255, 255, 255, 92);
    g.roundRect(trackX + 8, trackY + 3, trackW - 16, 4, 2);
    g.fill();

    g.strokeColor = new Color(UiTokens.color.blue.r, UiTokens.color.blue.g, UiTokens.color.blue.b, 118);
    g.lineWidth = 2.5;
    const arrowX = dockW / 2 - dockLayout.arrowInset;
    for (const dir of [-1, 1]) {
      const x = dir * arrowX;
      g.moveTo(x - dir * 8, trackY + 7);
      g.lineTo(x, trackY);
      g.lineTo(x - dir * 8, trackY - 7);
    }
    g.stroke();
  }

  private paintTicks(selected: number): void {
    if (!this.ticksG) return;
    const dockLayout = UiTokens.layout.actionDock;
    const trackY = -this.dockH * dockLayout.trackYRatio;
    const left = -this.dockW / 2 + dockLayout.tickInset;
    const right = this.dockW / 2 - dockLayout.tickInset;
    const span = Math.max(1, right - left);
    this.ticksG.clear();
    for (let i = 0; i < this.targetCount; i++) {
      const x = this.targetCount === 1 ? 0 : left + span * i / (this.targetCount - 1);
      const active = i === selected;
      this.ticksG.fillColor = active
        ? !this.targetValid
          ? new Color(UiTokens.color.muted.r, UiTokens.color.muted.g, UiTokens.color.muted.b, 205)
          : this.perfectReady
          ? new Color(UiTokens.color.gold.r, UiTokens.color.gold.g, UiTokens.color.gold.b, 245)
          : new Color(UiTokens.color.blue.r, UiTokens.color.blue.g, UiTokens.color.blue.b, 235)
        : new Color(142, 126, 108, 122);
      this.ticksG.roundRect(x - (active ? 6 : 3), trackY - (active ? 10 : 6), active ? 12 : 6, active ? 20 : 12, active ? 6 : 3);
      this.ticksG.fill();
    }
  }

  private paintHalo(perfectReady: boolean, targetValid: boolean, cancelArmed = false): void {
    if (!this.haloG) return;
    const focus = cancelArmed ? UiTokens.color.danger : !targetValid ? UiTokens.color.muted : perfectReady ? UiTokens.color.gold : UiTokens.color.blue;
    this.haloG.clear();
    this.haloG.fillColor = new Color(focus.r, focus.g, focus.b, perfectReady ? 62 : 30);
    this.haloG.circle(0, 0, 30);
    this.haloG.fill();
    this.haloG.strokeColor = new Color(255, 252, 246, 220);
    this.haloG.lineWidth = 5;
    this.haloG.circle(0, 0, 24);
    this.haloG.stroke();
    this.haloG.strokeColor = new Color(focus.r, focus.g, focus.b, perfectReady ? 238 : 188);
    this.haloG.lineWidth = perfectReady ? 4 : 3;
    this.haloG.circle(0, 0, 30);
    this.haloG.stroke();
  }
}
