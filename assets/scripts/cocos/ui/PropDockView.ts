import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens } from './UiTokens';

export interface PropDockLayoutInput {
  parent: Node;
  layer: number;
  propButtons: Node;
  buttonCount: number;
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
 * 道具长按后的操作区纯视图。
 *
 * 只负责节点创建、尺寸布局和绘制；长按/拖动/松手的玩法状态仍由 GameRunner 持有。
 */
export class PropDockView {
  private root: Node | null = null;
  private hintLabel: Label | null = null;

  layout(input: PropDockLayoutInput): PropDockLayoutResult {
    const root = this.ensure(input.parent, input.layer);
    const dockLayout = UiTokens.layout.actionDock;
    const dockW = Math.min(input.usedW + dockLayout.sidePadding, input.viewWidth - input.horizontalPadding * 2 + dockLayout.extraWidth);
    const lowerHudGap = Math.max(dockLayout.minHudGap, input.viewHeight * dockLayout.hudGapRatio);
    const dockBottom = input.buttonY - input.btnH / 2 - Math.max(dockLayout.minBottomGap, input.btnH * dockLayout.bottomGapRatio);
    const dockTopLimit = input.buttonY + input.btnH / 2 + lowerHudGap - Math.max(dockLayout.minTopInset, input.viewHeight * dockLayout.topInsetRatio);
    const dockAvailableH = Math.max(dockLayout.minAvailableHeight, dockTopLimit - dockBottom);
    const dockH = input.choosing
      ? Math.max(dockLayout.minHeight, Math.min(dockLayout.maxHeight, dockAvailableH))
      : input.btnH + dockLayout.idleExtraHeight;
    const dockY = input.choosing ? dockBottom + dockH / 2 : input.buttonY - 4;
    const active = input.choosing && input.playing;

    root.getComponent(UITransform)!.setContentSize(dockW, dockH);
    root.setPosition(0, dockY, 0);
    root.setSiblingIndex(Math.max(0, input.propButtons.getSiblingIndex() - 1));
    root.active = active;

    const g = root.getComponent(Graphics)!;
    g.clear();
    this.layoutHint(dockW, dockH, input.choosing);
    if (input.choosing) {
      this.paintDock(g, {
        dockW,
        dockH,
        buttonCount: input.buttonCount,
        startX: input.startX,
        btnW: input.btnW,
        gap: input.gap,
        aimingIndex: input.aimingIndex,
      });
    }

    return { node: root, active, dockW, dockH, dockY };
  }

  private ensure(parent: Node, layer: number): Node {
    if (this.root?.isValid) return this.root;
    this.root = new Node('ActionDock');
    this.root.layer = layer;
    this.root.parent = parent;
    this.root.addComponent(UITransform);
    this.root.addComponent(Graphics);

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

  private layoutHint(dockW: number, dockH: number, active: boolean): void {
    if (!this.hintLabel) return;
    const dockLayout = UiTokens.layout.actionDock;
    this.hintLabel.node.active = active;
    this.hintLabel.string = UiTokens.tutorial.dockHint;
    UiPainter.label(this.hintLabel, UiTokens.type.micro, new Color(118, 96, 72, 210), true);
    this.hintLabel.node.getComponent(UITransform)?.setContentSize(dockW - 52, dockLayout.hintHeight);
    this.hintLabel.node.setPosition(0, dockH / 2 - dockLayout.hintTopOffset, 0);
  }

  private paintDock(
    g: Graphics,
    state: {
      dockW: number;
      dockH: number;
      buttonCount: number;
      startX: number;
      btnW: number;
      gap: number;
      aimingIndex: number;
    },
  ): void {
    const { dockW, dockH, buttonCount, startX, btnW, gap, aimingIndex } = state;
    const dockLayout = UiTokens.layout.actionDock;
    const dockRadius = Math.min(dockLayout.radiusMax, Math.max(dockLayout.radiusMin, dockH * 0.15));

    g.fillColor = new Color(54, 48, 42, 32);
    g.roundRect(-dockW / 2 + 6, -dockH / 2 - 6, dockW - 12, dockH, dockRadius);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 246);
    g.strokeColor = new Color(166, 125, 88, 218);
    g.lineWidth = 3;
    g.roundRect(-dockW / 2, -dockH / 2, dockW, dockH, dockRadius);
    g.fill(); g.stroke();
    g.fillColor = new Color(255, 255, 255, 64);
    g.roundRect(-dockW / 2 + 18, dockH / 2 - 20, dockW - 36, 5, 3);
    g.fill();

    // 内层拇指操作槽：玩家长按后只需要盯住这一块拖动。
    g.fillColor = new Color(244, 229, 205, 152);
    g.roundRect(-dockW / 2 + 22, -dockH / 2 + 15, dockW - 44, dockH - 44, Math.max(10, dockRadius - 5));
    g.fill();
    g.strokeColor = new Color(166, 125, 88, 68);
    g.lineWidth = 1.5;
    g.roundRect(-dockW / 2 + 22, -dockH / 2 + 15, dockW - 44, dockH - 44, Math.max(10, dockRadius - 5));
    g.stroke();
    g.fillColor = new Color(166, 125, 88, 54);
    g.roundRect(-dockW / 2 + 34, -dockH / 2 + 24, dockW - 68, 5, 3);
    g.fill();

    const railY = -dockH * 0.12;
    g.strokeColor = new Color(166, 125, 88, 150);
    g.lineWidth = 4;
    g.moveTo(-dockW / 2 + dockLayout.railInset, railY);
    g.lineTo(dockW / 2 - dockLayout.railInset, railY);
    g.stroke();

    const chevronY = railY + 18;
    g.strokeColor = new Color(106, 140, 168, 118);
    g.lineWidth = 2.5;
    [-1, 1].forEach((dir) => {
      const cx = dir * Math.min(86, dockW * 0.18);
      g.moveTo(cx - dir * 10, chevronY + 7);
      g.lineTo(cx, chevronY);
      g.lineTo(cx - dir * 10, chevronY - 7);
      g.stroke();
    });

    for (let i = 0; i < buttonCount; i++) {
      const x = startX + i * (btnW + gap);
      if (i === aimingIndex) {
        g.fillColor = new Color(54, 48, 42, 34);
        g.circle(x + 3, railY - 3, dockLayout.handleRadius + 4);
        g.fill();
        g.fillColor = new Color(UiTokens.color.blue.r, UiTokens.color.blue.g, UiTokens.color.blue.b, 46);
        g.circle(x, railY, dockLayout.handleRadius + 3);
        g.fill();
        g.strokeColor = new Color(UiTokens.color.blue.r, UiTokens.color.blue.g, UiTokens.color.blue.b, 178);
        g.lineWidth = 3;
        g.circle(x, railY, dockLayout.handleRadius - 3);
        g.stroke();
        g.fillColor = UiTokens.color.blue;
        g.circle(x, railY, dockLayout.dotRadius + 1.5);
        g.fill();
      } else {
        g.fillColor = new Color(202, 190, 172, 210);
        g.circle(x, railY, dockLayout.dotRadius);
        g.fill();
      }
    }
  }
}
