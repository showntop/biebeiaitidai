import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiTokens } from './UiTokens';

/** 准星收益预告的纯视图；目标推导仍由玩法编排层提供。 */
export class AimPredictionView {
  readonly node: Node;
  readonly width = 236;
  readonly height = 40;
  private readonly graphics: Graphics;
  private readonly label: Label;

  constructor(parent: Node, layer: number) {
    const node = new Node('PropAimPrediction');
    node.layer = layer;
    node.parent = parent;
    node.addComponent(UITransform).setContentSize(this.width, this.height);
    this.graphics = node.addComponent(Graphics);

    const text = new Node('PropAimPredictionText');
    text.layer = layer;
    text.parent = node;
    text.addComponent(UITransform).setContentSize(this.width - 18, this.height - 6);
    this.label = text.addComponent(Label);
    this.label.fontFamily = 'PingFang SC';
    this.label.fontSize = 18;
    this.label.lineHeight = 22;
    this.label.isBold = true;
    this.label.horizontalAlign = 1;
    this.label.verticalAlign = 1;
    this.label.overflow = Label.Overflow.SHRINK;
    this.node = node;
  }

  update(text: string, accent: Readonly<Color>, valid: boolean, x: number, y: number): void {
    const g = this.graphics;
    g.clear();
    g.fillColor = new Color(54, 48, 42, 38);
    g.roundRect(-this.width / 2 + 3, -this.height / 2 - 4, this.width - 6, this.height, 13);
    g.fill();
    g.fillColor = new Color(255, 252, 246, 248);
    g.strokeColor = new Color(accent.r, accent.g, accent.b, valid ? 225 : 130);
    g.lineWidth = valid ? 2.5 : 1.5;
    g.roundRect(-this.width / 2, -this.height / 2, this.width, this.height, 12);
    g.fill(); g.stroke();
    this.label.string = text;
    this.label.color = valid ? UiTokens.color.inkDeep : UiTokens.color.muted;
    this.node.setPosition(x, y, 0);
    this.node.active = true;
  }

  setActive(active: boolean): void {
    if (this.node.isValid) this.node.active = active;
  }

  destroy(): void {
    if (this.node.isValid) this.node.destroy();
  }
}
