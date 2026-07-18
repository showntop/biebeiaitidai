import { Color, Graphics, Label, Node, tween, UITransform, UIOpacity, Vec3 } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens } from './UiTokens';
import type { GameResult } from '../../core/types';

export interface ResultDialogButton {
  name: string;
  text: string;
  color: Readonly<Color>;
  variant: 'primary' | 'secondary' | 'reward';
  tap: () => void;
}

export interface ResultDialogModel {
  parent: Node;
  layer: number;
  viewWidth: number;
  viewHeight: number;
  width: number;
  height: number;
  won: boolean;
  result: GameResult;
  title: string;
  badgeText: string;
  stars: number;
  peakApproval: number;
  finalApproval: number;
  timeUsedSec: number;
  maxCombo: number;
  effectiveHits: number;
  perfectHits: number;
  missedThrows: number;
  rank: string;
  day: number;
  meme: string;
  /** 按钮上方的一句话内容预告，给“下一关”一个明确动机。 */
  nextHook?: string;
  buttons: ResultDialogButton[];
}

export interface ResultDialogNodes {
  panel: Node;
  scrim: Node;
}

/**
 * 局结算弹窗纯视图。
 *
 * 只负责画面板、文字和按钮；Session 结算、复活/下一关动作仍由调用方提供。
 */
export class ResultDialogView {
  private panel: Node | null = null;
  private scrim: Node | null = null;

  show(model: ResultDialogModel): ResultDialogNodes {
    const panel = this.ensurePanel(model.parent, model.layer);
    const scrim = this.ensureScrim(model.parent, model.layer);
    const resultLayout = UiTokens.layout.result;

    panel.getComponent(UITransform)!.setContentSize(model.width, model.height);
    panel.setPosition(0, model.viewHeight * resultLayout.yRatio, 0);
    panel.active = true;

    scrim.getComponent(UITransform)!.setContentSize(model.viewWidth, model.viewHeight);
    const sg = scrim.getComponent(Graphics)!;
    sg.clear();
    sg.fillColor = new Color(78, 68, 56, 86);
    sg.rect(-model.viewWidth / 2, -model.viewHeight / 2, model.viewWidth, model.viewHeight);
    sg.fill();
    scrim.setPosition(0, 0, 0);
    scrim.active = true;
    scrim.setSiblingIndex(Math.max(0, panel.getSiblingIndex() - 1));

    panel.removeAllChildren();
    this.paintPanel(panel, model);
    this.animateIn(panel);

    return { panel, scrim };
  }

  hide(): void {
    if (this.panel) this.panel.active = false;
    if (this.scrim) this.scrim.active = false;
  }

  private ensurePanel(parent: Node, layer: number): Node {
    if (this.panel?.isValid) return this.panel;
    this.panel = new Node('ResultPanel');
    this.panel.layer = layer;
    this.panel.parent = parent;
    this.panel.addComponent(UITransform);
    this.panel.addComponent(Graphics);
    return this.panel;
  }

  private ensureScrim(parent: Node, layer: number): Node {
    if (this.scrim?.isValid) return this.scrim;
    this.scrim = new Node('ResultScrim');
    this.scrim.layer = layer;
    this.scrim.parent = parent;
    this.scrim.addComponent(UITransform);
    this.scrim.addComponent(Graphics);
    this.scrim.addComponent(UIOpacity);
    return this.scrim;
  }

  private paintPanel(panel: Node, model: ResultDialogModel): void {
    const resultLayout = UiTokens.layout.result;
    const pw = model.width;
    const ph = model.height;
    const cg = panel.getComponent(Graphics)!;
    this.paintResultCard(cg, pw, ph);

    // 顶部战报状态牌：纸质底 + 小状态章，避免纯红/绿系统条破坏当前暖纸质世界观。
    const statusW = pw * resultLayout.statusWidthRatio;
    const statusH = resultLayout.statusHeight;
    const statusY = ph / 2 - resultLayout.statusTopInset;
    cg.fillColor = new Color(72, 58, 44, 48);
    cg.roundRect(-statusW / 2 + 4, statusY - statusH / 2 - 4, statusW - 8, statusH, 14);
    cg.fill();
    cg.fillColor = new Color(255, 250, 241, 255);
    cg.strokeColor = new Color(166, 125, 88, 214);
    cg.lineWidth = 3;
    cg.roundRect(-statusW / 2, statusY - statusH / 2, statusW, statusH, 14);
    cg.fill(); cg.stroke();
    const badgeW = resultLayout.badgeWidth;
    const badgeX = statusW / 2 - badgeW / 2 - 12;
    cg.fillColor = model.won ? new Color(83, 170, 93, 235) : new Color(222, 84, 72, 238);
    cg.roundRect(badgeX - badgeW / 2, statusY - 16, badgeW, 32, 11);
    cg.fill();
    cg.strokeColor = new Color(255, 255, 255, 78);
    cg.lineWidth = 2;
    cg.moveTo(-statusW / 2 + 18, statusY + statusH / 2 - 10);
    cg.lineTo(statusW / 2 - badgeW - 20, statusY + statusH / 2 - 10);
    cg.stroke();

    const starY = ph / 2 - resultLayout.starTopInset;
    const starW = resultLayout.starWidth;
    cg.fillColor = new Color(76, 67, 58, 28);
    cg.roundRect(-starW / 2 + 3, starY - 22, starW - 6, 40, 12);
    cg.fill();
    cg.fillColor = new Color(255, 248, 225, 255);
    cg.strokeColor = new Color(202, 148, 56, 210);
    cg.lineWidth = 2;
    cg.roundRect(-starW / 2, starY - 20, starW, 40, 11);
    cg.fill(); cg.stroke();
    const ratingBox = 26;
    const ratingGap = 6;
    const ratingStartX = 0;
    for (let i = 0; i < 3; i++) {
      const rx = ratingStartX + i * (ratingBox + ratingGap);
      const active = i < model.stars;
      cg.fillColor = active ? new Color(255, 228, 130, 255) : new Color(245, 238, 225, 255);
      cg.strokeColor = active ? new Color(202, 148, 56, 230) : new Color(202, 178, 145, 150);
      cg.lineWidth = active ? 2.5 : 2;
      cg.circle(rx, starY, ratingBox / 2);
      cg.fill(); cg.stroke();
      if (active) {
        cg.strokeColor = new Color(126, 88, 31, 230);
        cg.lineWidth = 3;
        cg.moveTo(rx - 7, starY - 1);
        cg.lineTo(rx - 2, starY - 7);
        cg.lineTo(rx + 8, starY + 7);
        cg.stroke();
      }
    }

    // 三个指标筹码，替代原来一行“表格感”的 stats。
    const chipY = ph / 2 - resultLayout.chipTopInset;
    const chipW = (pw - resultLayout.chipHorizontalInset) / 3;
    [-1, 0, 1].forEach((offset) => {
      const cx = offset * (chipW + resultLayout.chipGap);
      cg.fillColor = new Color(76, 67, 58, 22);
      cg.roundRect(cx - chipW / 2 + 3, chipY - resultLayout.chipHeight / 2 - 3, chipW - 6, resultLayout.chipHeight, 13);
      cg.fill();
      cg.fillColor = new Color(255, 250, 241, 255);
      cg.strokeColor = new Color(185, 149, 112, 150);
      cg.lineWidth = 2;
      cg.roundRect(cx - chipW / 2, chipY - resultLayout.chipHeight / 2, chipW, resultLayout.chipHeight, 12);
      cg.fill(); cg.stroke();
      cg.fillColor = new Color(166, 125, 88, 98);
      cg.roundRect(cx - chipW / 2 + 12, chipY - resultLayout.chipHeight / 2 + 3, chipW - 24, 4, 2);
      cg.fill();
    });

    // 正文纸条：独立承载吐槽文本，不再在大空白里飘一行字。
    const noteW = pw - resultLayout.noteHorizontalInset;
    const noteH = resultLayout.noteHeight;
    const noteY = resultLayout.noteY;
    cg.fillColor = new Color(76, 67, 58, 18);
    cg.roundRect(-noteW / 2 + 4, noteY - noteH / 2 - 4, noteW - 8, noteH, 14);
    cg.fill();
    cg.fillColor = new Color(255, 252, 244, 255);
    cg.strokeColor = new Color(202, 178, 145, 128);
    cg.lineWidth = 2;
    cg.roundRect(-noteW / 2, noteY - noteH / 2, noteW, noteH, 13);
    cg.fill(); cg.stroke();

    const titleW = statusW - badgeW - 30;
    const titleX = -statusW / 2 + 14 + titleW / 2;
    this.addLabel(panel, 'Title', titleX, statusY, model.title, 40, titleW, 58, UiTokens.color.inkDeep, true);
    this.addLabel(panel, 'ResultBadge', badgeX, statusY, model.badgeText, 22, badgeW - 12, 38, new Color(255, 252, 240, 255), true);
    this.addLabel(panel, 'Stars', -starW * 0.29, starY, '评价', 28, 82, 42, new Color(166, 112, 0, 255), true);
    const metrics = this.metricsFor(model);
    this.addLabel(panel, 'StatsApproval', -(chipW + resultLayout.chipGap), chipY, `${metrics[0].label}\n${metrics[0].value}`, 21, chipW - 12, 62, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'StatsTime', 0, chipY, `${metrics[1].label}\n${metrics[1].value}`, 21, chipW - 12, 62, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'StatsCombo', chipW + resultLayout.chipGap, chipY, `${metrics[2].label}\n${metrics[2].value}`, 21, chipW - 12, 62, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'Stats2', 0, chipY - resultLayout.chipHeight, `${model.rank}   ·   第${model.day}轮反击`, 18, pw * 0.85, 32, new Color(95, 84, 70, 255), false);
    this.addLabel(panel, 'Meme', 0, noteY, model.meme, 22, noteW - 36, 92, new Color(100, 88, 72, 255), false);
    const memeLabel = panel.getChildByName('Meme')?.getComponent(Label);
    if (memeLabel) {
      memeLabel.enableWrapText = true;
      memeLabel.overflow = Label.Overflow.CLAMP;
      memeLabel.lineHeight = 30;
    }

    const btnGap = Math.min(resultLayout.buttonGapMax, Math.max(resultLayout.buttonGapMin, pw * resultLayout.buttonGapRatio));
    const btnW = Math.min(
      pw * resultLayout.buttonMaxWidthRatio,
      (pw * resultLayout.buttonAreaWidthRatio - btnGap * (model.buttons.length - 1)) / model.buttons.length,
    );
    const btnY = -ph / 2 + resultLayout.buttonBottomInset;
    const btnSpan = (model.buttons.length - 1) * (btnW + btnGap);
    model.buttons.forEach((button, i) => {
      this.makeButton(panel, button.name, -btnSpan / 2 + i * (btnW + btnGap), btnY, btnW, resultLayout.buttonHeight, button.text, button.color, button.variant, button.tap);
    });
    if (model.nextHook) {
      this.addLabel(
        panel,
        'NextHook',
        0,
        btnY + resultLayout.buttonHeight * 0.82,
        model.nextHook,
        18,
        pw * 0.78,
        34,
        UiTokens.color.muted,
        false,
      );
    }
  }

  private metricsFor(model: ResultDialogModel): Array<{ label: string; value: string }> {
    if (model.result === 'win-hunt') {
      return [
        { label: '反杀用时', value: `${model.timeUsedSec.toFixed(1)}s` },
        { label: '完美命中', value: `${model.perfectHits}` },
        { label: '最高连击', value: `${model.maxCombo}` },
      ];
    }
    if (model.result === 'win-survive') {
      return [
        { label: '风险峰值', value: `${Math.round(model.peakApproval)}` },
        { label: '有效命中', value: `${model.effectiveHits}` },
        { label: '最高连击', value: `${model.maxCombo}` },
      ];
    }
    return [
      { label: '最终风险', value: `${Math.round(model.finalApproval)}` },
      { label: '有效命中', value: `${model.effectiveHits}` },
      { label: '失误次数', value: `${model.missedThrows}` },
    ];
  }

  private addLabel(parent: Node, name: string, x: number, y: number, text: string, size: number, w: number, h: number, color: Color, bold: boolean): void {
    const node = new Node(name);
    node.layer = parent.layer;
    node.parent = parent;
    const ut = node.addComponent(UITransform);
    ut.setContentSize(w, h);
    node.setPosition(x, y, 0);
    const lbl = node.addComponent(Label);
    lbl.string = text;
    UiPainter.label(lbl, size, color, bold);
    lbl.horizontalAlign = 1;
    lbl.verticalAlign = 1;
    lbl.overflow = Label.Overflow.SHRINK;
    lbl.overflow = Label.Overflow.SHRINK;
  }

  private makeButton(parent: Node, name: string, x: number, y: number, w: number, h: number, text: string, base: Readonly<Color>, variant: ResultDialogButton['variant'], onTap: () => void): void {
    const btn = new Node(name);
    btn.layer = parent.layer;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h);
    btn.setPosition(x, y, 0);
    const g = btn.addComponent(Graphics);
    const paint = (pressed: boolean) => this.paintKeycap(g, w, h, base, variant, pressed);
    paint(false);

    const labelNode = new Node(`${name}Label`);
    labelNode.layer = parent.layer;
    labelNode.parent = btn;
    labelNode.addComponent(UITransform).setContentSize(w - 12, h - 6);
    labelNode.setPosition(0, 1, 0);
    const lbl = labelNode.addComponent(Label);
    lbl.string = text;
    UiPainter.label(lbl, 24, UiTokens.color.inkDeep, true);
    lbl.horizontalAlign = 1;
    lbl.verticalAlign = 1;

    const setPressed = (pressed: boolean) => {
      paint(pressed);
      labelNode.setPosition(0, pressed ? -3 : 1, 0);
    };
    btn.on(Node.EventType.TOUCH_END, () => { setPressed(false); onTap(); });
    btn.on(Node.EventType.TOUCH_START, () => setPressed(true));
    btn.on(Node.EventType.TOUCH_CANCEL, () => setPressed(false));
  }

  private paintKeycap(g: Graphics, w: number, h: number, accent: Readonly<Color>, variant: ResultDialogButton['variant'], pressed: boolean): void {
    g.clear();
    const faceShift = pressed ? -3 : 0;
    const lift = pressed ? 2 : 7;
    const radius = Math.min(18, Math.max(12, h * 0.24));
    g.fillColor = new Color(54, 48, 42, pressed ? 20 : 38);
    g.roundRect(-w / 2 + 5, -h / 2 - lift - 2, w - 10, h, radius);
    g.fill();
    g.fillColor = new Color(178, 139, 102, 206);
    g.roundRect(-w / 2 + 1, -h / 2 - lift, w - 2, h - 2, radius);
    g.fill();
    g.fillColor = UiTokens.environment.startCard;
    const outline = variant === 'primary' ? UiTokens.color.blue : variant === 'reward' ? UiTokens.color.amber : new Color(146, 106, 76, 255);
    g.strokeColor = new Color(outline.r, outline.g, outline.b, pressed ? 205 : 236);
    g.lineWidth = variant === 'primary' ? 4 : 3;
    g.roundRect(-w / 2 + 2, -h / 2 + 4 + faceShift, w - 4, h - lift - 5, radius);
    g.fill(); g.stroke();
    g.strokeColor = new Color(255, 255, 255, pressed ? 44 : 92);
    g.lineWidth = 2;
    g.moveTo(-w / 2 + radius + 5, h / 2 - lift - 10 + faceShift);
    g.lineTo(w / 2 - radius - 5, h / 2 - lift - 10 + faceShift);
    g.stroke();
    g.fillColor = new Color(accent.r, accent.g, accent.b, pressed ? 132 : variant === 'primary' ? 220 : 168);
    g.roundRect(-w / 2 + 14, -h / 2 + 10 + faceShift, w - 28, variant === 'primary' ? 7 : 5, 3);
    g.fill();
  }

  /** 与入口页同源的米白大卡：大圆角、柔和多层投影、极细暖灰描边。 */
  private paintResultCard(g: Graphics, w: number, h: number): void {
    const radius = Math.min(UiTokens.layout.result.cardRadius, w * 0.085);
    g.clear();
    for (let i = 0; i < 6; i++) {
      g.fillColor = new Color(108, 88, 62, Math.max(4, 22 - i * 3));
      g.roundRect(-w / 2 + 5 - i, -h / 2 - 12 - i * 3, w - 10 + i * 2, h + 2, radius + i * 2);
      g.fill();
    }
    g.fillColor = UiTokens.environment.startCard;
    g.strokeColor = new Color(214, 203, 188, 190);
    g.lineWidth = 2;
    g.roundRect(-w / 2, -h / 2, w, h, radius);
    g.fill();
    g.stroke();
  }

  private animateIn(panel: Node): void {
    const resultLayout = UiTokens.layout.result;
    const panelOpacity = panel.getComponent(UIOpacity) ?? panel.addComponent(UIOpacity);
    panelOpacity.opacity = 0;
    panel.setScale(resultLayout.appearScale, resultLayout.appearScale, 1);
    tween(panel).to(UiTokens.motion.panelSec, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    tween(panelOpacity).to(UiTokens.motion.resultFadeSec, { opacity: 255 }, { easing: 'quadOut' }).start();
  }
}
