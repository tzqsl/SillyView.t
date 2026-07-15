/**
 * SillyView - Configuration File
 *
 * This file centralizes all static configuration for the extension,
 * such as version numbers, World Book entry keys, and other constants.
 * This makes the codebase cleaner and easier to maintain.
 */

const ASSET_DEFINITIONS = {
    'BTCUSD': {
        code: 'BTCUSD',
        name: '比特币',
        type: 'Crypto',
        description: '领先的加密货币，以其高波动性而闻名，24/7全天候交易。',
        initial_price: 68000.00,
        quick_mode_params: { volatility: 0.02, drift: 0.0002 },
        trade_config: { spread_bps: 8, slippage_bps: 4, fee_rate: 0.001, maintenance_margin_rate: 0.005, funding_rate_hourly: 0.00004 },
        macro_exposure: { risk: 1.15, usd: -0.45, rates: -0.25, inflation: 0.10, energy: 0.05, crypto: 1.00 },
        trading_hours_per_day: 24,
        max_leverage: 100,
    },
    'ETHUSD': {
        code: 'ETHUSD',
        name: '以太坊',
        type: 'Crypto',
        description: '第二大加密货币，同样具有高波动性，是许多去中心化应用的基础。',
        initial_price: 3500.00,
        quick_mode_params: { volatility: 0.025, drift: 0.0003 },
        trade_config: { spread_bps: 10, slippage_bps: 5, fee_rate: 0.001, maintenance_margin_rate: 0.006, funding_rate_hourly: 0.00005 },
        macro_exposure: { risk: 1.25, usd: -0.50, rates: -0.30, inflation: 0.10, energy: 0.05, crypto: 1.20 },
        trading_hours_per_day: 24,
        max_leverage: 100,
    },
    'NASDAQ100': {
        code: 'NASDAQ100',
        name: '纳斯达克100指数',
        type: 'Index',
        description: '代表了100家最大的非金融类公司的市场指数，以科技股为主。',
        initial_price: 18000.00,
        quick_mode_params: { volatility: 0.007, drift: 0.0005 },
        trade_config: { spread_bps: 2, slippage_bps: 1, fee_rate: 0.0005, maintenance_margin_rate: 0.05, funding_rate_hourly: 0.00001 },
        macro_exposure: { risk: 1.00, usd: -0.20, rates: -0.90, inflation: -0.45, energy: -0.10, crypto: 0.15 },
        trading_hours_per_day: 8,
        max_leverage: 10,
    },
    'GOLD': {
        code: 'GOLD',
        name: '黄金',
        type: 'Commodity',
        description: '传统的避险资产，通常在市场不确定时表现良好。',
        initial_price: 2300.00,
        quick_mode_params: { volatility: 0.005, drift: 0.0001 },
        trade_config: { spread_bps: 3, slippage_bps: 1, fee_rate: 0.0004, maintenance_margin_rate: 0.025, funding_rate_hourly: 0.00001 },
        macro_exposure: { risk: -0.35, usd: -0.75, rates: -0.65, inflation: 0.55, energy: 0.10, crypto: -0.10 },
        trading_hours_per_day: 8,
        max_leverage: 20,
    },
    'OIL': {
        code: 'OIL',
        name: '原油',
        type: 'Commodity',
        description: '全球经济的重要能源，价格受地缘政治和供需关系影响巨大。',
        initial_price: 80.00,
        quick_mode_params: { volatility: 0.012, drift: 0 },
        trade_config: { spread_bps: 5, slippage_bps: 3, fee_rate: 0.0006, maintenance_margin_rate: 0.035, funding_rate_hourly: 0.00002 },
        macro_exposure: { risk: 0.40, usd: -0.35, rates: -0.15, inflation: 0.45, energy: 1.20, crypto: 0.00 },
        trading_hours_per_day: 8,
        max_leverage: 20,
    },
    'EURUSD': {
        code: 'EURUSD',
        name: '欧元/美元',
        type: 'Forex',
        description: '全球交易量最大的货币对，代表了欧元与美元之间的汇率。',
        initial_price: 1.0800,
        quick_mode_params: { volatility: 0.0025, drift: 0 },
        trade_config: { spread_bps: 1, slippage_bps: 0.5, fee_rate: 0.0002, maintenance_margin_rate: 0.02, funding_rate_hourly: 0.000005 },
        macro_exposure: { risk: 0.15, usd: -1.00, rates: 0.35, inflation: -0.10, energy: -0.15, crypto: 0.00 },
        trading_hours_per_day: 8,
        max_leverage: 50,
    }
};

const DEFAULT_BACKGROUND_AI_SETTINGS = {
    enabled: false,
    source: 'openai',
    apiurl: '',
    key: '',
    model: '',
    proxy_preset: '',
    temperature: 0.7,
    max_tokens: 600,
};

const LIFE_WORLDBOOK_ENTRIES = [
    {
        name: 'SillyView_生活财务指令_总则',
        content: [
            '这些指令用于处理现实生活、银行卡余额、债务和开局设定，不用于解释市场曲线或交易盈亏。',
            '交易软件可以直接通过银行卡交易，不区分交易账户与银行卡账户的资金。',
            '玩家的交易盈利和亏损由 SillyView 插件根据持仓和价格自动计算，不需要也不应该使用增加现金指令伪造交易盈利。',
            '只有工资、奖励、支出、生活事件、贷款、旧债等现实财务变化，才使用本世界书中的指令。',
            '所有指令必须放在消息末尾的单一 <command>...</command> 块中。',
        ].join('\n'),
        enabled: true,
    },
    {
        name: 'SillyView_现金变动指令',
        content: [
            '[Player.AddCash(amount, "reason")]：增加现金。只用于现实中的增加现金，例如工资、奖金、赞助、补贴、礼金、意外收入等。',
            '[Player.SubtractCash(amount, "reason")]：扣除现金。用于生活支出、罚款、账单、维修、医疗、消费、被盗损失等。',
            '不要用 Player.AddCash 表示投资盈利；不要用 Player.SubtractCash 表示交易亏损。交易相关盈亏由插件自动处理。',
        ].join('\n'),
        enabled: true,
    },
    {
        name: 'SillyView_债务与贷款指令',
        content: [
            '[Loan.Grant(amount, "reason")]：提供贷款，同时增加现金和债务。适用于银行放款、临时借款、融资机会等。',
            '[Loan.Repay(amount, "reason")]：要求还款，同时减少现金和债务。适用于强制还款、主动还款、债务催收等。',
            '[Player.AddDebt(amount, "reason")]：仅增加债务，不给予现金。用于设定故事背景中的已有欠款、旧日赌债、历史贷款、欠款继承等。',
            '如果贷款已经被花完，只需要使用 Player.AddDebt 增加债务，不要同时增加现金。',
        ].join('\n'),
        enabled: true,
    },
    {
        name: 'SillyView_开局资金示例',
        content: [
            '普通开局：给玩家启动资金时，可以使用 Player.AddCash。',
            '示例：<command>[Player.AddCash(100000, "新手启动资金")]</command>',
            '',
            '有负债开局：银行账户里有五万块，但初始负债十万块。',
            '示例：<command>[Player.AddCash(50000, "新手启动资金")]</command>',
            '示例：<command>[Player.AddDebt(100000, "先前的债务，贷款已经被花完")]</command>',
        ].join('\n'),
        enabled: true,
    },
];

export const MACRO_EVENT_SYSTEM = {
  keywords: ["随机性", "市场事件", "利好", "利空", "判定", "roll", "宏观"],
  core_mechanism: {
    description: "每2个小时使用一个范围在[1, 100]的随机数P来模拟市场的不可预测性。P的值决定了下一个市场事件的方向和强度。",
    input_variable: "P = {{roll:1d100}}",
    principle: "P离100越近，事件越【利好】，市场上涨动力越强。P离1越近，事件越【利空】，市场下跌压力越大。"
  },
  logic_tiers: [
    {
      range: "[100, 100]",
      level: "极端利好 (Extreme Bullish)",
      ai_instruction: "当前市场处于“极端利好”阶段。生成“黑天鹅”级别的重大利好新闻。这应该是足以改变市场格局的事件。例如：革命性的技术突破被证实、某个主要经济体宣布全面拥抱该技术、关键性的有利法案被通过。（增长范围 > 15%）",
      suggested_patterns: ["bull_run"]
    },
    {
      range: "[96, 99]",
      level: "重大利好 (Major Bullish)",
      ai_instruction: "当前市场处于“重大利好”阶段。生成足以引发市场FOMO情绪的重磅消息。例如：某项关键技术获得颠覆性进展、大型金融机构宣布推出相关投资产品、地缘政治风险大幅缓解。（增长范围 8% ~ 15%）",
      suggested_patterns: ["bull_run"]
    },
    {
      range: "[91, 95]",
      level: "显著利好 (Significant Bullish)",
      ai_instruction: "当前市场处于“显著利好”阶段。生成强劲的积极消息，能推动市场持续上涨。例如：行业巨头宣布建立战略合作、某项重要应用的用户数量激增、大型投资机构宣布增持。（增长范围 4% ~ 8%）",
      suggested_patterns: ["bull_run", "reversal_bull"]
    },
    {
      range: "[81, 90]",
      level: "温和利好 (Moderate Bullish)",
      ai_instruction: "当前市场处于“温和利好”阶段。生成偏向积极的市场情绪消息。例如：分析师普遍上调目标价、一项有利的行业数据公布、市场传出收购意向的流言。（增长范围 2% ~ 4%）",
      suggested_patterns: ["reversal_bull", "consolidation"]
    },
    {
      range: "[21, 80]",
      level: "中性区域 (Neutral Zone)",
      ai_instruction: "当前市场处于“中性区域”阶段。这是市场的常态。生成多空交织、方向不明的新闻，或者描述市场在“消化前期消息”、“等待新的催化剂”。例如：市场对昨天的消息反应不一、分析师们产生了分歧、交易量萎缩，市场情绪趋于谨慎。（波动范围 -2% ~ +2%）",
      suggested_patterns: ["consolidation", "volatile"]
    },
     {
      range: "[11, 20]",
      level: "温和利空 (Moderate Bearish)",
      ai_instruction: "当前市场处于“温和利空”阶段。生成偏向负面的市场情绪消息。例如：关键人物发表谨慎言论、出现技术阻力位、部分投资者选择获利了结。（下跌范围 2% ~ 4%）",
      suggested_patterns: ["reversal_bear", "consolidation"]
    },
    {
      range: "[6, 10]",
      level: "显著利空 (Significant Bearish)",
      ai_instruction: "当前市场处于“显著利空”阶段。生成强劲的负面消息，能引发市场的抛售。例如：低于预期的经济数据公布、监管机构宣布将进行调查、某项核心技术被发现存在安全漏洞。（下跌范围 4% ~ 8%）",
      suggested_patterns: ["bear_crash", "reversal_bear"]
    },
    {
      range: "[2, 5]",
      level: "重大利空 (Major Bearish)",
      ai_instruction: "当前市场处于“重大利空”阶段。生成足以引发市场抛售的重磅坏消息。例如：主要经济体经济数据显著恶化、某家大型公司宣布盈利预警、一项关键合作谈判破裂。（下跌范围 8% ~ 15%）",
      suggested_patterns: ["bear_crash"]
    },
    {
      range: "[1, 1]",
      level: "极端利空 (Extreme Bearish)",
      ai_instruction: "当前市场处于“极端利空”阶段。生成“黑天鹅”级别的重大利空新闻。这应该是足以引发恐慌性抛售的事件。例如：主要经济体宣布发布严厉禁令、发生重大的安全事故导致信任危机、某家大型交易所宣布倒闭。（下跌范围 > 15%）",
      suggested_patterns: ["bear_crash"]
    }
  ]
};


export const SillyViewConfig = {
    version: '2.1.0',
    extension_name: 'SillyView',

    // Expose asset definitions for other modules
    asset_definitions: ASSET_DEFINITIONS,
    background_ai_defaults: DEFAULT_BACKGROUND_AI_SETTINGS,
    market_context_worldbooks: ['SillyView_fx'],
    life_worldbook_name: 'SillyView_life',
    life_worldbook_entries: LIFE_WORLDBOOK_ENTRIES,
    
    macro_event_system: MACRO_EVENT_SYSTEM,

    // World Book Entry Keys
    world_book_keys: {
        config: 'sv_config',
        global_market: 'sv_global_market',
        player_portfolio: 'sv_player_portfolio',
        asset_prefix: 'sv_asset_',
        ai_context: 'sv_ai_context',
    },

    loan_config: {
        daily_interest_rate: 0.001, // 0.1% per day
        credit_limit_multiplier: 0.5, // Can borrow up to 50% of total assets
    },

    // Default state for a new game
    default_game_state: {
        config: {
            version: '2.1.0',
            max_hourly_records: 240,
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
                crypto_sentiment: 0,
                volatility_regime: 1
            }
        },
        player_portfolio: {
            cash: 0,
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
        }
    }
};
