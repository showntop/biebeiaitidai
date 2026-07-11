# Cocos 表现层接入（M2 占位 → M3 关卡流）

> 在 Cocos Creator 3.8.x 中搭场景，验证 core 规则层 + 关卡流（Session）能正确驱动画面。
> GameRunner 现在是 `core/Session` 的薄壳：继续进度 / 选关开打 / 结算战报 / 解锁段位 / 下一关重试。

## 场景搭建步骤

1. **新建/打开场景** `assets/scenes/Game.scene`

2. **场景结构**（在层级面板中按此创建）：

```
Canvas
├── LevelLabel (Label)     — 顶部：游戏标题 / 当前反替代任务
├── Timer (Label)          — 顶部居中：倒计时
├── Approval (Label)       — 左上："认可度: XX"
├── Zone (Label)           — 右上：当前分区
├── Belt (Node)             — 屏幕中部，水平排列
│   ├── Slot0 (Label)       — 6 个子节点，每个是一个 Label
│   ├── ...
│   └── Slot5 (Label)
├── ScanIndicator (Node)   — 小色块，跟随蓄力扫描高亮当前挡位
├── Props (Node)            — 底部，水平排列 4 个纸团按钮（顺序：加需求/改需求/甩锅/拍马屁）
│   ├── Prop0 (Node)         ⚠ 每个按钮必须有 UITransform(Width×Height≈160×80) + Sprite背景 + Button组件，否则点不到
│   ├── Prop1 (Node)
│   ├── Prop2 (Node)
│   └── Prop3 (Node)
├── ReportLabel (Label)    — 居中，默认隐藏；局结束显示战报(梗文案+星级+峰值+连击+反替代段位)
├── NextBtn (Node)         — 结算时显示，点按进下一关（hasNext=false 时隐藏）
└── RetryBtn (Node)        — 结算时显示，点按重试本关
```

3. **挂组件**：选中 Canvas（或根节点），Add Component → GameRunner，把上述节点拖入对应 `@property` 槽：
   `beltNode / approvalLabel / zoneLabel / timerLabel / propButtons / scanIndicator /
    levelLabel / reportLabel / nextBtn / retryBtn`。

4. **运行**（编辑器预览或微信小游戏构建）：
   - 进入"最高解锁关"（首次为第 1 关），当前反替代任务显示在顶部
   - 传送带 6 格刷新卡牌、认可度/分区/倒计时实时变化
   - 按住道具按钮 → 扫描指示器移动 → 松手命中；**未解锁道具按钮置灰**（如第 1 关的丢锅/拍马屁）
   - 局结束 → 战报面板出现，通关则解锁下一关、可点 NextBtn 继续；失败/重玩可点 RetryBtn
   - 进度自动存档（微信 `wx.setStorageSync`，Web 预览走 `localStorage`）

## 注意事项（cc 层，需在编辑器实测）

- GameRunner 的关卡流逻辑全部来自 `core/Session`（已在 Node 下 12 项单测覆盖）；此处只做节点接线与渲染。
- 关卡/解锁/段位/战报数值若不一致，优先查 `assets/config/levels/*.json` 与 `core/profile.ts`，不在 cc 层调。
- 占位渲染（文字+色块），美术资源接入后替换 `renderSlot`/`reportLabel` 的渲染即可，core 无需改动。

## 下一步

- 编辑器实测节点接线与本说明一致后，接入正式美术（AI 表情序列帧/卡牌贴图/道具动效/命中特效）。
- 扩关到 20 关，引入 Boss 临检关（§1.2 的 16~20），用 `npm run sim` 验证 Boss 关平衡。

## 排查：打不了 / 画面不动 / 按钮没反应

几乎都是**编辑器侧节点问题**（core 逻辑在 89 个单测里正常），按顺序查：

1. **看 Console（浏览器预览按 F12，编辑器 Preview 看 Console）**
   - 有红色报错 → 把报错贴出来，多半是某节点没接（null）。
   - 有 `[GameRunner] 道具按钮[X] 没有 UITransform...` 警告 → **就是按钮点不到的根因**：给该按钮节点加 `UITransform`，Width/Height 设 160×80（建议再加 Sprite 背景 + Button 组件）。
   - 有 `[GameRunner] propButtons 未接线` → 把底部 Props 节点拖进 GameRunner 的 `propButtons` 槽。

2. **看顶部 `[debug] 剩Xs over=Y` 这行**（临时诊断，正常后删）
   - 数字在变 → 游戏在正常跑，问题只在按钮命中区（见上）。
   - `over=true` → 局已经结束了（通关/失败）。这时结算面板应弹出；若没弹，是 `reportLabel/nextBtn/retryBtn` 没接线——接上即可。道具按钮在 over 后本来就不响应（正常）。
   - 数字不动、`over=false` → 真卡住了，看 Console 红错。

3. **按钮命中区**（最高频原因）：Cocos 3.x 触摸命中走 UITransform 包围盒。纯 Node 或只有 Label 的按钮命中区≈0，表现为"按钮没反应"。每个道具/流程按钮节点务必：`UITransform`(160×80) + `Sprite`(背景) + `Button`(可选，带按压反馈)。
