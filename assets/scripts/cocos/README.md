# M2 第一步：Cocos 表现层接入

> 在 Cocos Creator 3.8.x 中搭一个最小可玩场景，验证 core 规则层能正确驱动画面。

## 场景搭建步骤

1. **新建场景** `assets/scenes/Game.scene`

2. **场景结构**（在层级面板中按此创建）：

```
Canvas
├── Timer (Label)          — 顶部居中，显示倒计时
├── Approval (Label)       — 左上，显示 "认可度: XX"
├── Zone (Label)           — 右上，显示当前分区
├── Belt (Node)             — 屏幕中部，水平排列
│   ├── Slot0 (Label)       — 6个子节点，每个是一个Label
│   ├── Slot1 (Label)
│   ├── Slot2 (Label)
│   ├── Slot3 (Label)
│   ├── Slot4 (Label)
│   └── Slot5 (Label)
├── ScanIndicator (Node)   — 一个小色块，跟随蓄力扫描高亮当前挡位
├── Props (Node)            — 底部，水平排列4个按钮
│   ├── Prop0 (Node + Button)
│   ├── Prop1 (Node + Button)
│   ├── Prop2 (Node + Button)
│   └── Prop3 (Node + Button)
└── Result (Label)          — 居中，默认隐藏，局结束显示
```

3. **挂组件**：选中 Canvas（或任意根节点），Add Component → GameRunner，把上述节点拖入对应属性槽。

4. **运行**：点播放按钮，你应该看到：
   - 传送带6格从右到左刷新卡牌（占位文字）
   - 认可度数字实时变化
   - 按住道具按钮→扫描指示器移动→松手命中
   - 倒计时结束显示胜负结果

## 当前状态

- **占位渲染**：所有卡牌/UI都是文字+色块，不含美术资源
- **验证目标**：core事件能正确驱动Cocos节点，行为与单测一致
- **下一步**：验证通过后接入正式美术（AI表情/卡牌贴图/道具动效/命中特效）
