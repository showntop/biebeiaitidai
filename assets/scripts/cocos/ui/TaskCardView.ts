import { Color, Graphics, Label, Node, Sprite, UITransform } from 'cc';
import { UiPainter, type CardShellState } from './UiPainter';
import { UiTokens } from './UiTokens';

/** 任务卡的唯一视觉入口：尺寸、图标光学大小、权重和卡壳状态统一在此维护。 */
export class TaskCardView {
  static layout(node: Node, width: number, height: number): void {
    const ut = node.getComponent(UITransform);
    if (ut) ut.setContentSize(width, height);
    const icon = node.getChildByName('TaskIcon')?.getComponent(Sprite);
    if (icon) {
      // Demo 的任务卡质感来自“深色底 + 大图标”，移动端不能按槽位把图标缩成小贴纸。
      const size = Math.min(width * 0.86, height * 0.72);
      icon.node.getComponent(UITransform)?.setContentSize(size, size);
      icon.node.setPosition(0, height * 0.09, 0);
    }
    const legacyLabel = node.getComponent(Label);
    if (legacyLabel) legacyLabel.enabled = false;

    const title = TaskCardView.titleLabelFor(node);
    UiPainter.label(title, Math.min(13, Math.max(10, width * 0.13)), Color.WHITE, true);
    title.verticalAlign = 1;
    title.horizontalAlign = 1;
    title.node.getComponent(UITransform)?.setContentSize(width - 16, Math.max(14, height * 0.14));
    title.node.setPosition(0, -height * 0.35, 0);
    title.enabled = false;

    const value = TaskCardView.valueLabelFor(node);
    UiPainter.label(value, Math.min(13, Math.max(10, width * 0.13)), Color.WHITE, true);
    value.verticalAlign = 1;
    value.horizontalAlign = 1;
    value.node.getComponent(UITransform)?.setContentSize(Math.max(24, width * 0.34), Math.max(16, height * 0.14));
    value.node.setPosition(width * 0.26, height * 0.30, 0);
    value.enabled = false;
  }

  static titleLabelFor(node: Node): Label {
    return TaskCardView.labelFor(node, 'TaskTitle');
  }

  static valueLabelFor(node: Node): Label {
    return TaskCardView.labelFor(node, 'TaskValue');
  }

  private static labelFor(parent: Node, name: string): Label {
    let node = parent.getChildByName(name);
    if (!node) {
      node = new Node(name);
      node.layer = parent.layer;
      node.parent = parent;
      node.addComponent(UITransform);
    }
    const label = node.getComponent(Label) ?? node.addComponent(Label);
    label.enableWrapText = false;
    label.overflow = Label.Overflow.SHRINK;
    return label;
  }

  static paintShell(node: Node, base: Readonly<Color>, state: CardShellState): void {
    const ut = node.getComponent(UITransform);
    const g = node.getComponent(Graphics);
    if (!ut || !g) return;
    UiPainter.card(g, ut.width, ut.height, base, state);
  }
}
