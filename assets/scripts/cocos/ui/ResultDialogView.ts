import { Color, Graphics, Label, Node, tween, UITransform, UIOpacity, Vec3 } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens } from './UiTokens';

export interface ResultDialogButton {
  name: string;
  text: string;
  color: Readonly<Color>;
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
  title: string;
  badgeText: string;
  stars: number;
  peakApproval: number;
  timeUsedSec: number;
  maxCombo: number;
  rank: string;
  day: number;
  meme: string;
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
    UiPainter.panel(cg, pw, ph, false);

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
    const ratingBox = 28;
    const ratingGap = 8;
    const ratingStartX = 4;
    for (let i = 0; i < 3; i++) {
      const rx = ratingStartX + i * (ratingBox + ratingGap);
      const active = i < model.stars;
      cg.fillColor = active ? new Color(255, 228, 130, 255) : new Color(245, 238, 225, 255);
      cg.strokeColor = active ? new Color(202, 148, 56, 230) : new Color(202, 178, 145, 150);
      cg.lineWidth = active ? 2.5 : 2;
      cg.roundRect(rx - ratingBox / 2, starY - ratingBox / 2, ratingBox, ratingBox, 7);
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

    this.addLabel(panel, 'Title', -badgeW * 0.42, statusY, model.title, 28, pw * 0.85, 42, UiTokens.color.inkDeep, true);
    this.addLabel(panel, 'ResultBadge', badgeX, statusY, model.badgeText, 18, badgeW - 10, 28, new Color(255, 252, 240, 255), true);
    this.addLabel(panel, 'Stars', -starW * 0.28, starY, '评价', 22, 66, 32, new Color(166, 112, 0, 255), true);
    this.addLabel(panel, 'StatsApproval', -(chipW + resultLayout.chipGap), chipY, `峰值\n${Math.round(model.peakApproval)}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'StatsTime', 0, chipY, `耗时\n${model.timeUsedSec.toFixed(1)}s`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'StatsCombo', chipW + resultLayout.chipGap, chipY, `连击\n${model.maxCombo}`, 16, chipW - 8, 42, new Color(70, 60, 50, 255), true);
    this.addLabel(panel, 'Stats2', 0, chipY - resultLayout.chipHeight, `${model.rank}   ·   第${model.day}轮反击`, 15, pw * 0.85, 24, new Color(95, 84, 70, 255), false);
    this.addLabel(panel, 'Meme', 0, noteY, model.meme, 15, noteW - 28, 62, new Color(100, 88, 72, 255), false);

    const btnGap = Math.min(resultLayout.buttonGapMax, Math.max(resultLayout.buttonGapMin, pw * resultLayout.buttonGapRatio));
    const btnW = Math.min(
      pw * resultLayout.buttonMaxWidthRatio,
      (pw * resultLayout.buttonAreaWidthRatio - btnGap * (model.buttons.length - 1)) / model.buttons.length,
    );
    const btnY = -ph / 2 + resultLayout.buttonBottomInset;
    const btnSpan = (model.buttons.length - 1) * (btnW + btnGap);
    model.buttons.forEach((button, i) => {
      this.makeButton(panel, button.name, -btnSpan / 2 + i * (btnW + btnGap), btnY, btnW, resultLayout.buttonHeight, button.text, button.color, button.tap);
    });
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
  }

  private makeButton(parent: Node, name: string, x: number, y: number, w: number, h: number, text: string, base: Readonly<Color>, onTap: () => void): void {
    const btn = new Node(name);
    btn.layer = parent.layer;
    btn.parent = parent;
    btn.addComponent(UITransform).setContentSize(w, h);
    btn.setPosition(x, y, 0);
    const g = btn.addComponent(Graphics);
    const paint = (pressed: boolean) => this.paintKeycap(g, w, h, base, pressed);
    paint(false);

    const labelNode = new Node(`${name}Label`);
    labelNode.layer = parent.layer;
    labelNode.parent = btn;
    labelNode.addComponent(UITransform).setContentSize(w - 12, h - 6);
    labelNode.setPosition(0, 1, 0);
    const lbl = labelNode.addComponent(Label);
    lbl.string = text;
    UiPainter.label(lbl, 19, UiTokens.color.inkDeep, true);
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

  private paintKeycap(g: Graphics, w: number, h: number, accent: Readonly<Color>, pressed: boolean): void {
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
    g.strokeColor = new Color(146, 106, 76, pressed ? 205 : 236);
    g.lineWidth = 3;
    g.roundRect(-w / 2 + 2, -h / 2 + 4 + faceShift, w - 4, h - lift - 5, radius);
    g.fill(); g.stroke();
    g.strokeColor = new Color(255, 255, 255, pressed ? 44 : 92);
    g.lineWidth = 2;
    g.moveTo(-w / 2 + radius + 5, h / 2 - lift - 10 + faceShift);
    g.lineTo(w / 2 - radius - 5, h / 2 - lift - 10 + faceShift);
    g.stroke();
    g.fillColor = new Color(accent.r, accent.g, accent.b, pressed ? 108 : 158);
    g.roundRect(-w / 2 + 16, -h / 2 + 11 + faceShift, w - 32, 5, 3);
    g.fill();
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
