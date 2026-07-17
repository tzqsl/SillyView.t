/**
 * SillyView - Configuration File
 *
 * This file centralizes all static configuration for the extension,
 * such as version numbers, World Book entry keys, and other constants.
 * This makes the codebase cleaner and easier to maintain.
 */

const ASSET_DEFINITIONS = {
    'EURUSD': {
        code: 'EURUSD',
        name: '欧元/美元',
        type: 'Forex',
        description: '全球交易量最大的货币对，代表了欧元与美元之间的汇率。',
        initial_price: 1.0800,
        quick_mode_params: { volatility: 0.0025, drift: 0 },
        trade_config: { spread_bps: 1, slippage_bps: 0.5, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000005 },
        macro_exposure: { risk: 0.15, usd: -1.00, rates: 0.35, inflation: -0.10, energy: -0.15 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    },
    'GBPUSD': {
        code: 'GBPUSD',
        name: '英镑/美元',
        type: 'Forex',
        description: '波动较活跃的主要货币对，重点受英国经济、英格兰银行与美元周期影响。',
        initial_price: 1.2700,
        quick_mode_params: { volatility: 0.0030, drift: 0 },
        trade_config: { spread_bps: 1.4, slippage_bps: 0.7, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000006 },
        macro_exposure: { risk: 0.25, usd: -0.90, rates: 0.25, inflation: -0.10, energy: -0.10 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    },
    'USDJPY': {
        code: 'USDJPY',
        name: '美元/日元',
        type: 'Forex',
        description: '反映美日利差与避险资金流向的主要货币对。',
        initial_price: 148.00,
        quick_mode_params: { volatility: 0.0023, drift: 0 },
        trade_config: { spread_bps: 1.2, slippage_bps: 0.6, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000006 },
        macro_exposure: { risk: 0.35, usd: 0.85, rates: 0.80, inflation: 0.05, energy: 0.10 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    },
    'AUDUSD': {
        code: 'AUDUSD',
        name: '澳元/美元',
        type: 'Forex',
        description: '对全球风险偏好、亚洲经济与大宗商品周期较敏感的货币对。',
        initial_price: 0.6500,
        quick_mode_params: { volatility: 0.0032, drift: 0 },
        trade_config: { spread_bps: 1.5, slippage_bps: 0.8, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000007 },
        macro_exposure: { risk: 0.75, usd: -0.85, rates: 0.10, inflation: 0.05, energy: 0.25 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    },
    'USDCAD': {
        code: 'USDCAD',
        name: '美元/加元',
        type: 'Forex',
        description: '受美加经济差异、美元强弱与能源出口周期共同驱动的货币对。',
        initial_price: 1.3600,
        quick_mode_params: { volatility: 0.0024, drift: 0 },
        trade_config: { spread_bps: 1.4, slippage_bps: 0.7, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000006 },
        macro_exposure: { risk: -0.20, usd: 0.75, rates: 0.20, inflation: -0.05, energy: -0.55 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    },
    'USDCHF': {
        code: 'USDCHF',
        name: '美元/瑞郎',
        type: 'Forex',
        description: '由美元周期、欧美利差和避险需求主导的主要货币对。',
        initial_price: 0.8800,
        quick_mode_params: { volatility: 0.0021, drift: 0 },
        trade_config: { spread_bps: 1.3, slippage_bps: 0.6, fee_rate: 0.0002, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.000005 },
        macro_exposure: { risk: 0.30, usd: 0.70, rates: 0.45, inflation: -0.05, energy: 0.00 },
        trading_hours_per_day: 24,
        max_leverage: 50,
    }
};

const DEFAULT_BACKGROUND_AI_SETTINGS = {
    enabled: false,
    source: 'openai',
    apiurl: '',
    key: '',
    model: '',
    temperature: 0.7,
    max_tokens: 20000,
    timeout_ms: 60000,
};

export const MACRO_EVENT_SYSTEM = {
  keywords: ["随机性", "市场事件", "利好", "利空", "判定", "roll", "宏观"],
  core_mechanism: {
    description: "每2个小时使用一个范围在[1, 100]的随机数P来模拟市场的不可预测性。P的值决定了下一个市场事件的方向和强度。",
    input_variable: "P = {{roll:1d100}}",
    principle: "涨跌始终相对于当前目标货币对：P越接近100，基础货币相对计价货币越强；P越接近1，基础货币相对计价货币越弱。"
  },
  logic_tiers: [
    {
      range: "[100, 100]",
      level: "极端利好 (Extreme Bullish)",
      ai_instruction: "为目标货币对生成极端上行事件，例如基础货币央行意外大幅加息、计价货币央行紧急降息，或关键政策发生突变。必须说明两种货币为何产生强弱差。（涨幅通常 1% ~ 2.5%）",
      suggested_patterns: ["bull_run"]
    },
    {
      range: "[96, 99]",
      level: "重大利好 (Major Bullish)",
      ai_instruction: "为目标货币对生成重大上行事件，例如基础货币经济数据大幅超预期、央行转鹰，或计价货币遭遇明显政策利空。（涨幅通常 0.7% ~ 1.5%）",
      suggested_patterns: ["bull_run"]
    },
    {
      range: "[91, 95]",
      level: "显著利好 (Significant Bullish)",
      ai_instruction: "为目标货币对生成显著上行事件，例如利差预期扩大、就业或通胀数据支持基础货币，推动资金持续流入。（涨幅通常 0.4% ~ 0.9%）",
      suggested_patterns: ["bull_run", "reversal_bull"]
    },
    {
      range: "[81, 90]",
      level: "温和利好 (Moderate Bullish)",
      ai_instruction: "为目标货币对生成温和上行事件，例如次级经济数据略好于预期、央行官员措辞偏鹰或风险流向轻微有利。（涨幅通常 0.15% ~ 0.5%）",
      suggested_patterns: ["reversal_bull", "consolidation"]
    },
    {
      range: "[21, 80]",
      level: "中性区域 (Neutral Zone)",
      ai_instruction: "生成符合外汇常态的中性事件：市场等待央行会议或关键数据，多空因素互相抵消，货币对维持区间波动。（波动通常 -0.3% ~ +0.3%）",
      suggested_patterns: ["consolidation", "volatile"]
    },
     {
      range: "[11, 20]",
      level: "温和利空 (Moderate Bearish)",
      ai_instruction: "为目标货币对生成温和下行事件，例如基础货币数据略弱、央行措辞偏鸽或短线资金流向计价货币。（跌幅通常 0.15% ~ 0.5%）",
      suggested_patterns: ["reversal_bear", "consolidation"]
    },
    {
      range: "[6, 10]",
      level: "显著利空 (Significant Bearish)",
      ai_instruction: "为目标货币对生成显著下行事件，例如基础货币关键数据明显不及预期、降息概率上升或利差快速收窄。（跌幅通常 0.4% ~ 0.9%）",
      suggested_patterns: ["bear_crash", "reversal_bear"]
    },
    {
      range: "[2, 5]",
      level: "重大利空 (Major Bearish)",
      ai_instruction: "为目标货币对生成重大下行事件，例如基础货币央行意外转鸽、经济衰退风险陡升，或计价货币获得强政策支撑。（跌幅通常 0.7% ~ 1.5%）",
      suggested_patterns: ["bear_crash"]
    },
    {
      range: "[1, 1]",
      level: "极端利空 (Extreme Bearish)",
      ai_instruction: "为目标货币对生成极端下行事件，例如基础货币央行紧急降息、汇率政策突变、主权信用危机，或计价货币央行意外大幅加息。（跌幅通常 1% ~ 2.5%）",
      suggested_patterns: ["bear_crash"]
    }
  ]
};


export const SillyViewConfig = {
    version: '2.2.0',
    extension_name: 'SillyView',

    // Expose asset definitions for other modules
    asset_definitions: ASSET_DEFINITIONS,
    background_ai_defaults: DEFAULT_BACKGROUND_AI_SETTINGS,
    market_context_worldbooks: ['SillyView_fx'],
    multi_account: {
        control_worldbook_name: 'SillyView_accounts',
        account_index_key: 'sv_accounts_index',
        account_state_key: 'sv_account_state',
        command_entry_key: 'sv_accounts_trade_commands',
        account_query_key: 'sv_accounts_query',
        scan_report_key: 'sv_accounts_scan_report',
        recent_news_key: 'sv_accounts_recent_news',
    },
    
    macro_event_system: MACRO_EVENT_SYSTEM,

    // World Book Entry Keys
    world_book_keys: {
        config: 'sv_config',
        global_market: 'sv_global_market',
        player_portfolio: 'sv_player_portfolio',
        asset_prefix: 'sv_asset_',
        ai_context: 'sv_ai_context',
        dialogue_context: 'sv_dialogue_context',
        kline_context: 'sv_kline_context',
        market_targets: 'sv_market_targets',
    },

    loan_config: {
        daily_interest_rate: 0.001, // 0.1% per day
        credit_limit_multiplier: 0.5, // Can borrow up to 50% of total assets
    },

    // Default state for a new game
    default_game_state: {
        config: {
            version: '2.2.0',
            max_hourly_records: 240,
            max_minute_records: 720,
            initial_bootstrap_done: false,
            background_ai: { ...DEFAULT_BACKGROUND_AI_SETTINGS },
            // The list of assets to be created at the start of a new game
            available_assets: Object.keys(ASSET_DEFINITIONS)
        },
        global_market: {
            current_time_index: 0,
            current_datetime: "2025年09月22日-星期一-09:00",
            current_period: "上午",
            current_season: "秋季",
            current_weather: "晴",
            time_resolution: "HOURLY",
            minute_time_index: 0,
            market_status: "OPEN",
            news_feed: [],
            personality_state: 'CONSOLIDATION',
            personality_duration_remaining: 10,
            remaining_candles: 15,
            macro_state: {
                risk_sentiment: 0,
                usd_strength: 0,
                rate_pressure: 0,
                inflation_pressure: 0,
                energy_pressure: 0,
                volatility_regime: 1
            }
        },
        player_portfolio: {
            cash: 10000,
            starting_cash: 10000,
            debt: 0,
            assets: {},
            actions_this_turn: [],
            isQuickModeEnabled: false,
            asset_history: [],
            transaction_log: [],
        },
        ai_context: {
            comment: "这是AI可见的市场摘要。请基于此信息进行决策。",
            market_summary: [],
            player_cash: 0.00
        },
        kline_context: {
            comment: "Compact K-line context for market judgment. columns=[t,o,h,l,c].",
            updated_at: 0,
            updated_minute_at: 0,
            assets: []
        },
        market_targets: {
            comment: "AI-controlled long/short market targets. Expired targets are removed automatically. long uses end_time hour index, short uses end_minute minute index.",
            updated_at: 0,
            updated_minute_at: 0,
            targets: {}
        },
        dialogue_context: {
            comment: "这是给普通对话 AI 阅读的市场同步摘要。请按顺序阅读 summary 数组，不要把它当作用户发言。",
            updated_at: 0,
            summary: ["SillyView 市场同步摘要尚未生成。"]
        }
    }
};
