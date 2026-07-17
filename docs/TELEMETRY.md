# 数据事件与首局漏斗

当前实现先使用本地环形日志验证事件质量，后续接微信/第三方数据平台时只替换 `TelemetrySink`，
不改规则层与交互层。日志最多保留 400 条，不记录昵称、openid、输入文本等个人信息。

## 首批事件

| 事件 | 触发时机 | 关键字段 |
| --- | --- | --- |
| `session_start` | 游戏启动 | appVersion、platform、deviceTier |
| `level_start` | 一局创建 | levelIndex、seed、runId |
| `tutorial_shown` | 首关教学出现 | step |
| `prop_hold_started` | 道具按下 | prop |
| `first_drag` | 本局首次有效拖动 | sinceLevelStartMs |
| `first_release` | 本局首次松手投出 | prop、sinceLevelStartMs |
| `first_valid_hit` | 本局首次有效命中 | prop、quality、sinceLevelStartMs |
| `first_perfect` | 本局首次 Perfect | prop、sinceLevelStartMs |
| `invalid_target` | 空位或目标不接受道具 | prop、reason |
| `gesture_cancel` | 真实手势取消 | prop |
| `approval_zone_changed` | 认可度跨区 | from、to |
| `boss_warning` | Boss 进入预警挡位 | tier、slot |
| `revive_used` | 复活成功 | runId |
| `result_type` | 最终结算 | result、stars |
| `fail_reason` | 最终失败 | unhandled-task / boss-inspection / unknown |
| `level_end` | 一局最终结束 | 见局末聚合 |
| `retry / next_level / return_home` | 结算或返回操作 | 继承上一局 runId、levelIndex |

首次失败但仍可复活时不会立刻发 `level_end`；复活成功后继续沿用原 runId，最终只结算一次。

## 局末聚合

`level_end` 同时提供：首击耗时、有效命中率、Perfect 率、取消率、无效目标次数、四种道具使用分布、
FPS P50/P10、认可度峰值/终值、最终结果和星级。内部首轮目标值见
[`CURRENT_STATE_AND_ROADMAP.md`](./CURRENT_STATE_AND_ROADMAP.md)。

## 本地验收

Web 预览控制台可执行：

```js
globalThis.__BRAATN_TELEMETRY__.dump()
globalThis.__BRAATN_TELEMETRY__.flush()
globalThis.__BRAATN_TELEMETRY__.clear()
```

正式 Web 预览在局末/返回首页时写入 `localStorage.braatn_telemetry_v1`；QA 查询参数使用内存日志，
不会污染真实数据。自动化验收至少断言：`level_start → prop_hold_started → first_drag → first_release → first_valid_hit`。
