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

  private valueBaseX = 0;

  layout(width: number, height: number): void {
    this.root.getComponent(UITransform)?.setContentSize(width, height);
    this.barW = width - UiTokens.space.lg * 2;
    this.barH = 24;
    this.barY = -12;

    // 上排：左侧"认可度 + 数字"，右侧分区药丸；下方是进度条；底部一行提示。
    const rowY = height / 2 - 22;
    this.valueBaseX = -this.barW / 2;
    this.zoneBaseX = this.barW / 2 - 40;
    this.zoneBaseY = rowY;

    // 数字行左对齐（内部再拼小标签"认可度"），锚在进度条左端上方。
    this.place(this.value, this.valueBaseX + width * 0.24, rowY, width * 0.5, 34);
    this.place(this.zone, this.zoneBaseX, this.zoneBaseY, 80, 26);
    this.place(this.hint, 0, -height / 2 + 15, this.barW, 22);

    UiPainter.label(this.value, UiTokens.type.value, UiTokens.color.inkDeep, true);
    UiPainter.label(this.zone, UiTokens.type.caption, UiTokens.color.paper, true);
    UiPainter.label(this.hint, UiTokens.type.caption, alphaColor(UiTokens.color.muted, 210));
    this.value.horizontalAlign = 0;

    // 静态凹槽轨道：暖色软槽 + 顶部内阴影，营造"嵌进桌面"的深度，而不是浮在墙上的平条。
    this.frame.clear();
    const g = this.frame;
    const y = this.barY;
    const r = this.barH / 2;
    // 轨道投影
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 26);
    g.roundRect(-this.barW / 2, y - this.barH / 2 - 3, this.barW, this.barH, r);
    g.fill();
    // 凹槽底
    g.fillColor = mixColor(UiTokens.color.ivory, UiTokens.color.ink, 0.16);
    g.strokeColor = alphaColor(UiTokens.color.ink, 120);
    g.lineWidth = UiTokens.stroke.hairline;
    g.roundRect(-this.barW / 2, y - this.barH / 2, this.barW, this.barH, r);
    g.fill(); g.stroke();
    // 顶部内阴影
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 40);
    g.roundRect(-this.barW / 2 + 5, y + this.barH / 2 - 8, this.barW - 10, 5, 2.5);
    g.fill();

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
    this.value.string = `认可度  ${approval}`;
    this.zone.string = copy[zone] ?? zone;
    this.hint.string = hintText;

    // 危险时分区徽章轻微抖动。
    const shakeX = danger ? Math.sin(elapsed * 22) * 1.6 : 0;
    this.zone.node.setPosition(this.zoneBaseX + shakeX, this.zoneBaseY, 0);

    const g = this.dynamic;
    g.clear();

    // 分区药丸徽章：胶囊底 + 白字，颜色即信息。
    const badgeW = 66;
    const badgeH = 24;
    const bx = this.zoneBaseX + shakeX;
    g.fillColor = alphaColor(UiTokens.color.inkDeep, 24);
    g.roundRect(bx - badgeW / 2, this.zoneBaseY - badgeH / 2 - 2, badgeW, badgeH, badgeH / 2);
    g.fill();
    g.fillColor = zoneColor;
    g.roundRect(bx - badgeW / 2, this.zoneBaseY - badgeH / 2, badgeW, badgeH, badgeH / 2);
    g.fill();
    g.fillColor = alphaColor(Color.WHITE, 46);
    g.roundRect(bx - badgeW / 2 + 4, this.zoneBaseY + badgeH / 2 - 8, badgeW - 8, 4, 2);
    g.fill();

    // 进度填充：圆角 + 顶部高光带 + 底部暗边，做出体量感。
    const inset = 4;
    const innerH = this.barH - inset * 2;
    const trackInnerW = this.barW - inset * 2;
    const fillW = Math.max(pct > 0 ? innerH : 0, trackInnerW * pct);
    const left = -this.barW / 2 + inset;
    if (fillW > 0) {
      g.fillColor = zoneColor;
      g.roundRect(left, this.barY - innerH / 2, fillW, innerH, innerH / 2);
      g.fill();
      // 顶部高光带
      g.fillColor = alphaColor(mixColor(zoneColor, Color.WHITE, 0.5), 150);
      g.roundRect(left + 3, this.barY + 1, Math.max(0, fillW - 6), innerH * 0.4, innerH * 0.2);
      g.fill();
      // 底部暗边
      g.fillColor = alphaColor(mixColor(zoneColor, UiTokens.color.inkDeep, 0.5), 90);
      g.roundRect(left + 3, this.barY - innerH / 2 + 1, Math.max(0, fillW - 6), 3, 1.5);
      g.fill();

      // 滑块手柄：白色小圆钮 + 分区色环，位于填充前端，像一个可抓的进度旋钮。
      const knobX = left + fillW;
      const knobR = this.barH * 0.62;
      g.fillColor = alphaColor(UiTokens.color.inkDeep, 40);
      g.circle(knobX, this.barY - 2, knobR);
      g.fill();
      g.fillColor = Color.WHITE;
      g.strokeColor = zoneColor;
      g.lineWidth = 3;
      g.circle(knobX, this.barY, knobR);
      g.fill(); g.stroke();
      g.fillColor = zoneColor;
      g.circle(knobX, this.barY, knobR * 0.42);
      g.fill();
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
