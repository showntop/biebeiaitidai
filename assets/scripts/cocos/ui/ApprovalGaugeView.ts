import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens, alphaColor } from './UiTokens';

/** 认可度仪表：结构、排版、动态游标和危险态都封装在一个组件里。 */
export class ApprovalGaugeView {
  private readonly frame: Graphics;
  private readonly dynamic: Graphics;
  private readonly value: Label;
  private readonly zone: Label;
  private readonly scale: Label;
  private readonly eventTag: Label;
  private readonly event: Label;
  private barW = 0;
  private barH = 0;
  private barY = 0;

  constructor(private readonly root: Node) {
    this.frame = root.getComponent(Graphics) ?? root.addComponent(Graphics);
    this.dynamic = this.ensureGraphics('Dynamic');
    this.value = this.ensureLabel('ApprovalValue');
    this.zone = this.ensureLabel('Zone');
    this.scale = this.ensureLabel('Scale');
    this.eventTag = this.ensureLabel('EventTag');
    this.event = this.ensureLabel('Event');
  }

  layout(width: number, height: number): void {
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.barW = width - UiTokens.space.md;
    this.barH = 44;
    this.barY = 6;

    this.frame.clear();
    UiPainter.gauge(this.frame, this.barW, this.barH);

    this.place(this.value, -this.barW * 0.28, height / 2 - 18, width * 0.40, 36);
    this.place(this.zone, this.barW * 0.31, height / 2 - 18, width * 0.22, 34);
    this.place(this.scale, 0, this.barY - this.barH / 2 - 13, this.barW, 22);
    this.place(this.eventTag, -this.barW / 2 + 48, -height / 2 + 20, 78, 28);
    this.place(this.event, 44, -height / 2 + 20, this.barW - 104, 30);

    UiPainter.label(this.value, UiTokens.type.value, UiTokens.color.ink, true);
    UiPainter.label(this.zone, UiTokens.type.action, UiTokens.color.good, true);
    UiPainter.label(this.scale, UiTokens.type.micro, UiTokens.color.muted);
    UiPainter.label(this.eventTag, UiTokens.type.caption, UiTokens.color.paper, true);
    UiPainter.label(this.event, UiTokens.type.caption, UiTokens.color.ink);
    this.scale.string = '0          18          49          69          100';
    this.eventTag.string = '事件';
    this.event.horizontalAlign = 0;

    // 独立事件胶囊：左侧铭牌 + 状态灯 + 内容区，避免像一条空白输入框。
    const eventW = this.barW;
    const eventH = 32;
    const eventY = -height / 2 + 20;
    this.frame.fillColor = alphaColor(UiTokens.color.paper, 246);
    this.frame.strokeColor = alphaColor(UiTokens.color.ink, 88);
    this.frame.lineWidth = UiTokens.stroke.hairline;
    this.frame.roundRect(-eventW / 2, eventY - eventH / 2, eventW, eventH, 12);
    this.frame.fill();
    this.frame.stroke();
    this.frame.fillColor = alphaColor(UiTokens.color.inkDeep, 218);
    this.frame.roundRect(-eventW / 2 + 5, eventY - eventH / 2 + 5, 84, eventH - 10, 8);
    this.frame.fill();
    this.frame.fillColor = UiTokens.color.amber;
    this.frame.circle(-eventW / 2 + 17, eventY, 3.5);
    this.frame.fill();
    this.frame.strokeColor = alphaColor(Color.WHITE, 55);
    this.frame.lineWidth = UiTokens.stroke.hairline;
    this.frame.moveTo(-eventW / 2 + 102, eventY - 8);
    this.frame.lineTo(-eventW / 2 + 102, eventY + 8);
    this.frame.stroke();

    this.dynamic.node.getComponent(UITransform)?.setContentSize(width, height);
    this.dynamic.node.setPosition(0, 0, 0);
  }

  update(approval: number, zone: string, eventText: string, elapsed: number): void {
    const copy: Record<string, string> = { hunt: '猎杀!', good: '良好', ok: '勉强', danger: '危险!' };
    const colors: Record<string, Readonly<Color>> = {
      hunt: UiTokens.color.hunt,
      good: UiTokens.color.good,
      ok: UiTokens.color.ok,
      danger: UiTokens.color.danger,
    };
    const pct = Math.max(0, Math.min(1, approval / 100));
    this.value.string = `认可度  ${approval}`;
    this.zone.string = copy[zone] ?? zone;
    const zoneColor = colors[zone] ?? UiTokens.color.ink;
    this.zone.color = new Color(zoneColor.r, zoneColor.g, zoneColor.b, zoneColor.a);
    this.event.string = eventText;

    const g = this.dynamic;
    g.clear();
    const inset = 5;
    const fillW = Math.max(0, (this.barW - inset * 2) * pct);
    const innerH = this.barH - inset * 2;
    if (fillW > 0) {
      g.fillColor = zoneColor;
      g.roundRect(-this.barW / 2 + inset, this.barY - innerH / 2, fillW, innerH, innerH / 2);
      g.fill();
      g.strokeColor = alphaColor(Color.WHITE, 60);
      g.lineWidth = UiTokens.stroke.hairline;
      g.moveTo(-this.barW / 2 + inset + innerH / 2, this.barY + innerH / 2 - 6);
      g.lineTo(-this.barW / 2 + inset + Math.max(innerH / 2, fillW - innerH / 2), this.barY + innerH / 2 - 6);
      g.stroke();
    }

    const x = -this.barW / 2 + inset + fillW;
    g.fillColor = UiTokens.color.inkDeep;
    g.moveTo(x, this.barY + this.barH / 2 + 2);
    g.lineTo(x - 7, this.barY + this.barH / 2 + 13);
    g.lineTo(x + 7, this.barY + this.barH / 2 + 13);
    g.close();
    g.fill();
    if (zone === 'danger') {
      const alpha = Math.round(120 + (Math.sin(elapsed * 8) + 1) * 45);
      g.strokeColor = alphaColor(UiTokens.color.danger, alpha);
      g.lineWidth = UiTokens.stroke.strong;
      g.roundRect(-this.barW / 2 - 3, this.barY - this.barH / 2 - 3, this.barW + 6, this.barH + 6, this.barH / 2 + 3);
      g.stroke();
    }
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
