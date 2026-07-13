import { Color, Graphics, Label, Node, UITransform } from 'cc';
import { UiPainter } from './UiPainter';
import { UiTokens, alphaColor, mixColor } from './UiTokens';

/**
 * 认可度仪表：一块贴桌沿的小纸质铭牌。
 *
 * 信息降噪原则（小游戏 HUD 语言）：
 *  - 不显示阈值刻度数字：绿/黄/红分区颜色本身就是信息；
 *  - 不显示事件控制台：事件反馈全部走 FxLayer 飘字；
 *  - 危险态只保留一个抖动徽章，不再叠加外圈脉冲描边。
 * 底部保留一行无框提示小字（教学引导用），视觉权重最低。
 */
export class ApprovalGaugeView {
  private readonly frame: Graphics;
  private readonly dynamic: Graphics;
  private readonly value: Label;
  private readonly zone: Label;
  private readonly hint: Label;
  private barW = 0;
  private barH = 0;
  private barY = 0;
  private zoneBaseX = 0;
  private zoneBaseY = 0;

  constructor(private readonly root: Node) {
    this.frame = root.getComponent(Graphics) ?? root.addComponent(Graphics);
    this.dynamic = this.ensureGraphics('Dynamic');
    this.value = this.ensureLabel('ApprovalValue');
    this.zone = this.ensureLabel('Zone');
    this.hint = this.ensureLabel('Hint');
    // 清理旧版本残留的刻度/事件节点（热更或重复布局时避免叠影）
    ['Scale', 'EventTag', 'Event'].forEach((name) => {
      const stale = root.getChildByName(name);
      if (stale) stale.destroy();
    });
  }

  layout(width: number, height: number): void {
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.barW = width - UiTokens.space.lg * 2;
    this.barH = 38;
    this.barY = -4;

    this.frame.clear();
    // 纸质铭牌底：让 HUD 属于桌面世界，而不是浮在墙上的仪表盘。
    UiPainter.panel(this.frame, width, height);
    UiPainter.gauge(this.frame, this.barW, this.barH);

    this.zoneBaseX = this.barW * 0.5 - 44;
    this.zoneBaseY = height / 2 - 24;
    this.place(this.value, -this.barW * 0.5 + width * 0.20, height / 2 - 24, width * 0.40, 34);
    this.place(this.zone, this.zoneBaseX, this.zoneBaseY, 96, 30);
    this.place(this.hint, 0, -height / 2 + 16, this.barW, 24);

    UiPainter.label(this.value, UiTokens.type.value, UiTokens.color.inkDeep, true);
    UiPainter.label(this.zone, UiTokens.type.caption, UiTokens.color.paper, true);
    UiPainter.label(this.hint, UiTokens.type.caption, alphaColor(UiTokens.color.muted, 210));
    this.value.horizontalAlign = 0;

    this.dynamic.node.getComponent(UITransform)?.setContentSize(width, height);
    this.dynamic.node.setPosition(0, 0, 0);
  }

  update(approval: number, zone: string, hintText: string, elapsed: number): void {
    const copy: Record<string, string> = { hunt: '猎杀!', good: '良好', ok: '勉强', danger: '危险!' };
    const colors: Record<string, Readonly<Color>> = {
      hunt: UiTokens.color.hunt,
      good: UiTokens.color.good,
      ok: UiTokens.color.ok,
      danger: UiTokens.color.danger,
    };
    const pct = Math.max(0, Math.min(1, approval / 100));
    const zoneColor = colors[zone] ?? UiTokens.color.ink;
    const danger = zone === 'danger';
    this.value.string = `认可度 ${approval}`;
    this.zone.string = copy[zone] ?? zone;
    this.hint.string = hintText;

    // 危险时徽章轻微抖动，替代旧版的三重红色噪音（红字+红填充+红脉冲圈）。
    const shakeX = danger ? Math.sin(elapsed * 22) * 1.6 : 0;
    this.zone.node.setPosition(this.zoneBaseX + shakeX, this.zoneBaseY, 0);

    const g = this.dynamic;
    g.clear();

    // 状态徽章底：小胶囊，白字，颜色即分区信息。
    const badgeW = 76;
    const badgeH = 27;
    g.fillColor = mixColor(zoneColor, UiTokens.color.inkDeep, 0.12);
    g.roundRect(this.zoneBaseX + shakeX - badgeW / 2, this.zoneBaseY - badgeH / 2, badgeW, badgeH, badgeH / 2);
    g.fill();

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

    // 游标：小三角贴在条下沿。
    const x = -this.barW / 2 + inset + fillW;
    g.fillColor = UiTokens.color.inkDeep;
    g.moveTo(x, this.barY - this.barH / 2 - 1);
    g.lineTo(x - 6, this.barY - this.barH / 2 - 11);
    g.lineTo(x + 6, this.barY - this.barH / 2 - 11);
    g.close();
    g.fill();
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
