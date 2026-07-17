# SillyView.t

SillyView 是一个 SillyTavern / Tavern Helper 模拟市场插件。它会为当前角色创建独立世界书，保存账户、行情、新闻、AI 市场目标和交易记录。

## 主要功能

- 纯外汇行情：EURUSD、GBPUSD、USDJPY、AUDUSD、USDCAD、USDCHF。
- K 线视图：分钟、小时、日线，并带成交量；分K短线信号会结合小时K和AI长短线目标。
- 交易系统：做多、做空、加仓、平仓、杠杆、手续费、点差、滑点。
- 风控系统：强平、止盈、止损，持仓后可调整止盈止损。
- 资金系统：初始 10000 信用点、贷款、贷款利息、杠杆资金费率。
- 易上手交易：10% / 25% / 50% / 75% / 全仓快捷金额、做多保护、做空保护、实时风险档位。
- 多角色账户：初始化时扫描角色卡绑定世界书中的开户行格式，自动创建 `SillyView_accounts` 总控世界书，并把多个账号写入其中的独立状态词条。
- 市场推进：AI 导演模式和本地快速模式，快速模式支持 5/15/30 分钟、1小时和1天推进。
- 上下文同步：生成 `sv_dialogue_context` 和 `sv_kline_context` 给普通对话 AI 读取。
- 任务与绩效：新手任务板、当前净值、总收益率、最大回撤、已实现盈亏和胜率。

## 使用方式

1. 在 SillyTavern 中启用插件并打开面板。
2. 为当前角色创建 SillyView 世界书。
3. 在资产页查看任务板，按“下一步”提示完成基础目标。
4. 在交易页选择资产，用 10% / 25% / 50% / 75% / 全仓快捷金额填入交易金额。
5. 点击“做多保护”或“做空保护”自动填入止盈止损。
6. 使用“结束回合”让 AI 推进市场，或打开“快速模式”本地推进行情。
7. 在资产页查看账户、仓位、风控、任务进度和绩效。

## 新手流程

推荐第一局这样玩：

1. 选择 EURUSD 或 GBPUSD。
2. 用 10% 快捷金额开一笔小仓位。
3. 使用对应方向的保护预设。
4. 推进 1 小时或结束回合。
5. 观察未实现盈亏、新闻和任务板变化。
6. 盈亏达到目标后平仓，完成第一轮复盘。

## AI 指令

AI 市场导演应在一个 `<command>...</command>` 块内输出指令，例如：

```text
[Market.SetLongTarget("EURUSD", 1.1000, 12, "bull_trend", "美元走弱推动欧元上行", 0.7)]
[Market.Advance("EURUSD", "HOURLY", 1.0920, "bull_run")]
[Time.Set("2025年09月22日-星期一-10:00", "上午", "秋季", "晴")]
```

如果 AI 没有推进必要资产，插件会用本地市场模拟补齐，避免行情卡住。

## 多角色账户

初始化时，插件会扫描当前角色卡绑定的主世界书和附加世界书。只要某个条目里存在完整开户行格式，就会自动：

1. 创建或更新 `SillyView_accounts`，并绑定到角色卡附加世界书。
2. 按开户行账户数量在 `SillyView_accounts` 内写入多个 `sv_account_state_*` 独立账号状态词条。
3. 在 `SillyView_accounts` 写入交易指令、实时账目查询、`sv_kline_context` 和最近十条新闻。

`SillyView_fx` 不会被改写；它仍然只作为原有附加市场世界书上下文使用。

推荐开户行文本格式：

```text
开户行: 星海商业银行
户名: 林浅
账号: 6222-0001
余额: 50000
负债: 10000
```

也支持 JSON：

```json
{
  "开户行": "星海商业银行",
  "户名": "林浅",
  "账号": "6222-0001",
  "余额": 50000,
  "负债": 10000
}
```

AI 可读取 `SillyView_accounts` 中的 `sv_accounts_query` 获取 account_id，然后使用：

```text
[Trade.Buy("account_id", "EURUSD", 1000, 5, 1.1000, 1.0600)]
[Trade.Sell("account_id", "GBPUSD", 500, 5, 1.2300, 1.3100)]
[Trade.SetRisk("account_id", "EURUSD", 1.1050, 1.0550)]
[Trade.CloseLong("account_id", "EURUSD")]
```

`Buy` / `Sell` 与 UI 语义一致：买入会开多/加多/平空，卖出会开空/加空/平多。更明确的指令包括 `OpenLong`、`OpenShort`、`AddLong`、`AddShort`、`CloseLong`、`CloseShort`。

## 数据说明

核心数据保存在当前角色绑定的世界书中：

- `sv_config`：插件配置和可用资产。
- `sv_global_market`：时间、新闻、宏观状态和市场目标。
- `sv_player_portfolio`：现金、债务、持仓、交易记录、资产曲线。
- `sv_asset_*`：每个资产的 K 线和当前价格。
- `sv_dialogue_context`：给普通对话 AI 的市场摘要。
- `sv_kline_context`：紧凑 K 线摘要。
- `sv_market_targets`：AI 设置的长短线目标。
- `SillyView_accounts`：多角色协同交易总控附加世界书，包含指令、账目、K线摘要、新闻和每个账户的 `sv_account_state_*` 独立状态词条。

## 当前建议路线

下一批最值得做的是挂单系统，包括限价单、条件单、移动止损和 OCO。它会触碰交易执行、K 线触发和 UI 状态，适合单独实现和测试。
