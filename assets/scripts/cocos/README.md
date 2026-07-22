# Cocos 表现层接入（M2 占位 → M3 关卡流）

> 在 Cocos Creator 3.8.x 中搭场景，验证 core 规则层 + 关卡流（Session）能正确驱动画面。
> GameRunner 负责流程组装；`PropDockView`、`ApprovalGaugeView`、`PropButtonView`、`TaskCardView`、`ResultDialogView` 已承接主要纯视图职责。

## 可复现视觉验收入口

Web 构建启动后，可用查询参数直接进入关键画面。所有 QA 场景使用内存存档、固定随机种子，
不会修改玩家进度；场景建立后会冻结规则推进，适合 390×844 截图回归。

```text
?qa=entry&seed=424242&level=1
?qa=playing&seed=424242&level=1
?qa=drag&seed=424242&level=1
?qa=perfect&seed=424242&level=1
?qa=onboarding-perfect&seed=424242&level=2
?qa=onboarding-hunt&seed=424242&level=3
?qa=crisis&seed=424242&level=1
?qa=result-lose&seed=424242&level=1
?qa=result-survive&seed=424242&level=1
?qa=result-hunt&seed=424242&level=1
?qa=result-daily&seed=424242&level=6
?qa=result-rankup&seed=424242&level=1
```

浏览器自动化可等待 `globalThis.__BRAATN_QA__.ready === true`，并读取其中的卡片签名验证同种子复现。

操作音效、震动、四种道具重量与性能基线见 [`docs/SENSORY_FEEDBACK.md`](../../../docs/SENSORY_FEEDBACK.md)。

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
   - 长按加需求/改需求/甩锅 → 进入底部投掷滑轨 → 左右选择任务 → 金色准星表示 Perfect → 松手投出
   - 拍马屁是即时技能，点按后直接飞向 AI，不进入任务卡瞄准
   - 局结束 → 战报面板出现；通关显示下一关，失败只显示立即重试/复活/回到选关
   - 进度自动存档（微信 `wx.setStorageSync`，Web 预览走 `localStorage`）

## 注意事项（cc 层，需在编辑器实测）

- GameRunner 的关卡流逻辑全部来自 `core/Session`（当前规则层共 132 项单测覆盖）；此处只做节点接线与渲染。
- 关卡/解锁/段位/战报数值若不一致，优先查 `assets/config/levels/*.json` 与 `core/profile.ts`，不在 cc 层调。
- 占位渲染（文字+色块），美术资源接入后替换 `renderSlot`/`reportLabel` 的渲染即可，core 无需改动。

## 运行时 QA 门槛

改动 `assets/scripts/cocos/`、场景或资源后必须完成：

1. `npm run typecheck`
2. `npm test`
3. Cocos Creator `web-mobile` 构建
4. 390×844 入口页、主界面、拖拽态、结算态截图
5. 浏览器无业务 error
6. 微信小游戏包体不超过 4 MB，且保持引擎插件分离

## 排查：打不了 / 画面不动 / 按钮没反应

几乎都是**编辑器侧节点问题**（core 逻辑在 132 个单测里正常），按顺序查：

1. **看 Console（浏览器预览按 F12，编辑器 Preview 看 Console）**
   - 有红色报错 → 把报错贴出来，多半是某节点没接（null）。
   - 有 `[GameRunner] 道具按钮[X] 没有 UITransform...` 警告 → **就是按钮点不到的根因**：给该按钮节点加 `UITransform`，Width/Height 设 160×80（建议再加 Sprite 背景 + Button 组件）。
   - 有 `[GameRunner] propButtons 未接线` → 把底部 Props 节点拖进 GameRunner 的 `propButtons` 槽。

2. **看顶部 `[debug] 剩Xs over=Y` 这行**（临时诊断，正常后删）
   - 数字在变 → 游戏在正常跑，问题只在按钮命中区（见上）。
   - `over=true` → 局已经结束了（通关/失败）。这时结算面板应弹出；若没弹，是 `reportLabel/nextBtn/retryBtn` 没接线——接上即可。道具按钮在 over 后本来就不响应（正常）。
   - 数字不动、`over=false` → 真卡住了，看 Console 红错。

3. **按钮命中区**（最高频原因）：Cocos 3.x 触摸命中走 UITransform 包围盒。纯 Node 或只有 Label 的按钮命中区≈0，表现为"按钮没反应"。每个道具/流程按钮节点务必：`UITransform`(160×80) + `Sprite`(背景) + `Button`(可选，带按压反馈)。

## 排查：`Can not find class 'cc.PhysicMaterial'`

Cocos Creator 3.8.8 的内置默认物理材质仍使用旧类名 `cc.PhysicMaterial`，运行时依靠物理框架注册兼容别名；即使项目没有主动使用刚体，构建仍会序列化这份默认材质。

- `settings/v2/packages/engine.json` 必须保持 `physics = physics-builtin`，不能只为了缩包关闭整个物理框架。
- 本项目是纯 2D：`3d` 保持关闭，场景中不要保留 `DirectionalLight`，天空盒必须禁用并清空立方体贴图。
- 修改引擎裁剪配置后，先停止旧 Preview，再完全退出并重启 Creator 3.8.8；旧预览页缓存着上一版引擎脚本，单纯刷新有时不会重建别名注册链。
- 发布前同时检查构建产物中 `cc.PhysicMaterial` 与 `cc.PhysicsMaterial` 均存在，并执行 `tests/cocos-scene-integrity.test.ts`。
