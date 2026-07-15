/**
 * SillyView - Data Manager (v6.3 - Robustness Hotfix)
 * Manages all interactions with SillyTavern's World Book, state caching, and snapshots.
 */
'use strict';

import { Logger } from '../logger.js';
import { SillyViewConfig } from '../config.js';

export class DataManager {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.th = dependencies.th;
        this.logger = dependencies.logger;
        this.config = dependencies.config;
        this.positionCalculator = dependencies.positionCalculator;

        this.ui = null; // Injected by App
        this.isInitialized = false;

        this._stateCache = new Map();
        this.hasGameBook = false;
    }

    async _getLorebookName() {
        const charName = await this.th.substitudeMacros('{{char}}');
        if (!charName || charName === '{{char}}') return null;
        return `${this.config.extension_name}_${charName}`;
    }

    async loadInitialState() {
        this.logger.log("正在加载初始状态...");
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) {
            this.ui.renderError("无法确定角色名称。");
            return;
        }

        const allBooks = await this.th.getWorldbookNames();
        this.hasGameBook = allBooks.includes(lorebookName);

        if (this.hasGameBook) {
            this.logger.log(`游戏世界书 "${lorebookName}" 已找到，正在加载数据...`);
            await this.loadAllEntries(lorebookName);
            await this.ensureDialogueContextEntry(lorebookName);
            await this.updateDialogueContext();
            this.ui.renderMainInterface();
        } else {
            this.logger.log("未找到游戏世界书，渲染创建界面。");
            this.ui.renderCreationInterface();
        }
    }

    async loadAllEntries(lorebookName) {
        const entries = await this.th.getWorldbook(lorebookName);
        if (!entries) {
            this.logger.error("无法获取世界书条目数组。");
            this._stateCache.clear();
            return;
        }

        this._stateCache.clear();
        for (const entry of entries) {
            this._stateCache.set(entry.name, this._parseEntryContent(entry.content));
        }
        this.logger.success("所有游戏数据已加载到缓存。");
    }

    _parseEntryContent(content) {
        try {
            return JSON.parse(content);
        } catch (e) {
            return content;
        }
    }

    getState(key) {
        return this.dependencies.win._.cloneDeep(this._stateCache.get(key) || null);
    }

    async updateState(key, updateFn) {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) return;

        const currentState = this.dependencies.win._.cloneDeep(this._stateCache.get(key) || {});
        const newState = updateFn(currentState);
        this._stateCache.set(key, newState);

        await this.th.updateWorldbookWith(lorebookName, (entries) => {
            const entry = entries.find(e => e.name === key);
            if (entry) {
                entry.content = JSON.stringify(newState, null, 2);
            }
            return entries;
        });
    }

    async updateTextEntry(key, content) {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) return;

        this._stateCache.set(key, content);
        await this.th.updateWorldbookWith(lorebookName, (entries) => {
            let entry = entries.find(e => e.name === key);
            if (!entry) {
                entry = { name: key, content: '', enabled: true };
                entries.push(entry);
            }
            entry.content = content;
            entry.enabled = true;
            return entries;
        });
    }

    async ensureDialogueContextEntry(lorebookName) {
        const key = this.config.world_book_keys.dialogue_context;
        const defaultContent = JSON.stringify(this.config.default_game_state.dialogue_context, null, 2);

        await this.th.updateWorldbookWith(lorebookName, entries => {
            const entry = entries.find(item => item.name === key);
            if (entry) {
                entry.enabled = true;
            } else {
                entries.push({ name: key, content: defaultContent, enabled: true });
            }
            return entries;
        });

        if (!this._stateCache.has(key)) {
            this._stateCache.set(key, this.dependencies.win._.cloneDeep(this.config.default_game_state.dialogue_context));
        }
    }

    async saveAllEntries() {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) return;

        Logger.log(`Saving all ${this._stateCache.size} state entries to "${lorebookName}"...`);
        await this.th.updateWorldbookWith(lorebookName, (entries) => {
            for (const entry of entries) {
                if (this._stateCache.has(entry.name)) {
                    const value = this._stateCache.get(entry.name);
                    entry.content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
                }
            }
            return entries;
        });
    }

    async createInitialWorldState() {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) {
            this.logger.error("无法创建世界书：未选择角色。");
            return;
        }

        this.logger.log(`正在创建新的游戏世界书: "${lorebookName}"...`);
        const defaults = this.config.default_game_state;
        const keys = this.config.world_book_keys;

        // Initialize with a random candle count for immediate quick mode use
        const initialGlobalMarket = {
            ...defaults.global_market,
            remaining_candles: Math.floor(Math.random() * 30) + 1
        };

        const entriesTemplate = [
            { name: keys.config, content: JSON.stringify(defaults.config, null, 2), enabled: true },
            { name: keys.global_market, content: JSON.stringify(initialGlobalMarket, null, 2), enabled: true },
            { name: keys.player_portfolio, content: JSON.stringify(defaults.player_portfolio, null, 2), enabled: true },
            { name: keys.ai_context, content: JSON.stringify(defaults.ai_context, null, 2), enabled: true },
            { name: keys.dialogue_context, content: JSON.stringify(defaults.dialogue_context, null, 2), enabled: true },
        ];

        defaults.config.available_assets.forEach(assetCode => {
            const assetDef = this.config.asset_definitions[assetCode];
            if (assetDef) {
                const initialAssetData = {
                    code: assetDef.code,
                    name: assetDef.name,
                    type: assetDef.type,
                    description: assetDef.description,
                    current_price: assetDef.initial_price,
                    kline_hourly: [{
                        time: 0,
                        open: assetDef.initial_price,
                        high: assetDef.initial_price,
                        low: assetDef.initial_price,
                        close: assetDef.initial_price,
                        volume: 0
                    }],
                    kline_daily: [],
                };
                entriesTemplate.push({
                    name: `${keys.asset_prefix}${assetCode}`,
                    content: JSON.stringify(initialAssetData, null, 2),
                    enabled: false,
                });
            }
        });

        await this.th.createOrReplaceWorldbook(lorebookName, entriesTemplate);

        const charBooks = await this.th.getCharWorldbookNames('current');
        if (!charBooks.additional.includes(lorebookName)) {
            await this.th.rebindCharWorldbooks('current', {
                primary: charBooks.primary,
                additional: [...charBooks.additional, lorebookName]
            });
        }

        this._stateCache.clear();
        for (const entry of entriesTemplate) {
            this._stateCache.set(entry.name, this._parseEntryContent(entry.content));
        }
        this.hasGameBook = true;
        await this.updateAIContext();
        this.ui.renderMainInterface();
    }
    
    async resetAllData() {
        this.logger.warn("正在重置所有SillyView数据...");
        await this.createInitialWorldState(); // Re-running the creation process effectively resets everything.
        this.dependencies.win.toastr.success("所有数据已重置到初始状态。");
    }

    createSnapshot() {
        return this.dependencies.win._.cloneDeep(this._stateCache);
    }

    restoreStateFromSnapshot(snapshot) {
        this._stateCache = this.dependencies.win._.cloneDeep(snapshot);
        Logger.log("State restored from snapshot.");
    }

    async setWorldTime({ time, period, season, weather }) {
        await this.updateState(this.config.world_book_keys.global_market, market => {
            if (time) market.current_datetime = time;
            if (period) market.current_period = period;
            if (season) market.current_season = season;
            if (weather) market.current_weather = weather;
            return market;
        });
    }

    _getRecentCloseHistory(assetData, limit = 8) {
        const candles = assetData?.kline_hourly || [];
        return candles.slice(-limit).map(c => Number(c.close.toFixed(6)));
    }

    _calculatePortfolioMarkedValue(portfolio) {
        if (!portfolio) return 0;

        let positionValue = 0;
        if (portfolio.assets) {
            for (const assetCode of Object.keys(portfolio.assets)) {
                const position = this.positionCalculator.calculate(assetCode, portfolio);
                if (!position.type || position.totalAmount <= 0) continue;

                const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = assetData?.current_price ?? position.avgEntryPrice;
                const pnl = position.type === 'short'
                    ? (position.avgEntryPrice - lastPrice) * position.totalShares
                    : (lastPrice - position.avgEntryPrice) * position.totalShares;
                positionValue += position.totalAmount + pnl;
            }
        }

        return (portfolio.cash || 0) + positionValue - (portfolio.debt || 0);
    }

    async updateAIContext() {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const market = this.getState(keys.global_market) || {};
        const portfolio = this.getState(keys.player_portfolio) || {};
        const availableAssets = configState?.available_assets || Object.keys(this.config.asset_definitions);

        const marketSummary = availableAssets.map(assetCode => {
            const assetDef = this.config.asset_definitions[assetCode];
            const assetData = this.getState(`${keys.asset_prefix}${assetCode}`);
            const hourly = assetData?.kline_hourly || [];
            const latest = hourly[hourly.length - 1];
            const previousDay = hourly.length > 24 ? hourly[hourly.length - 25] : null;
            const latestPrice = assetData?.current_price ?? latest?.close ?? assetDef?.initial_price ?? 0;
            const change24h = previousDay ? ((latestPrice / previousDay.close) - 1) * 100 : 0;

            return {
                code: assetCode,
                name: assetDef?.name || assetCode,
                type: assetDef?.type || 'Unknown',
                latest_price: Number(latestPrice.toFixed(6)),
                change_24h_pct: Number(change24h.toFixed(3)),
                latest_volume: latest?.volume || 0,
                recent_close_history: this._getRecentCloseHistory(assetData),
            };
        });

        await this.updateState(keys.ai_context, context => ({
            ...(context || {}),
            comment: "这是AI可见的市场摘要。请基于此信息进行决策。",
            market_summary: marketSummary,
            player_cash: Number((portfolio.cash || 0).toFixed(2)),
            player_debt: Number((portfolio.debt || 0).toFixed(2)),
            player_net_worth: Number(this._calculatePortfolioMarkedValue(portfolio).toFixed(2)),
            current_time_index: market.current_time_index || 0,
            current_time: market.current_datetime || "未知",
            current_period: market.current_period || "未知",
            current_season: market.current_season || "未知",
            current_weather: market.current_weather || "未知",
            macro_state: market.macro_state || {},
        }));
        await this.updateDialogueContext(marketSummary);
    }

    _formatSigned(value, digits = 2) {
        const number = Number(value || 0);
        return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}`;
    }

    _buildPositionSummary(portfolio) {
        const lines = [];
        for (const assetCode of Object.keys(portfolio?.assets || {})) {
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (!position.type || position.totalAmount <= 0) continue;

            const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
            const lastPrice = assetData?.current_price ?? position.avgEntryPrice;
            const pnl = position.type === 'short'
                ? (position.avgEntryPrice - lastPrice) * position.totalShares
                : (lastPrice - position.avgEntryPrice) * position.totalShares;
            const pnlPct = position.totalAmount > 0 ? (pnl / position.totalAmount) * 100 : 0;
            const direction = position.type === 'short' ? '空头' : '多头';
            const leverage = position.isLeveraged ? ` ${position.leverage}x` : '';

            lines.push(`- ${assetCode}: ${direction}${leverage}，保证金 ${position.totalAmount.toFixed(2)}，入场 ${position.avgEntryPrice.toFixed(4)}，现价 ${lastPrice.toFixed(4)}，未实现盈亏 ${this._formatSigned(pnl)} (${this._formatSigned(pnlPct)}%)`);
        }

        return lines.length > 0 ? lines : ['- 当前没有持仓。'];
    }

    async updateDialogueContext(existingMarketSummary = null) {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const market = this.getState(keys.global_market) || {};
        const portfolio = this.getState(keys.player_portfolio) || {};
        const availableAssets = configState?.available_assets || Object.keys(this.config.asset_definitions);
        const marketSummary = existingMarketSummary || availableAssets.map(assetCode => {
            const assetDef = this.config.asset_definitions[assetCode];
            const assetData = this.getState(`${keys.asset_prefix}${assetCode}`);
            const hourly = assetData?.kline_hourly || [];
            const latest = hourly[hourly.length - 1];
            const previousDay = hourly.length > 24 ? hourly[hourly.length - 25] : null;
            const latestPrice = assetData?.current_price ?? latest?.close ?? assetDef?.initial_price ?? 0;
            const change24h = previousDay ? ((latestPrice / previousDay.close) - 1) * 100 : 0;

            return {
                code: assetCode,
                name: assetDef?.name || assetCode,
                latest_price: latestPrice,
                change_24h_pct: change24h,
            };
        });

        const newsLines = (market.news_feed || []).slice(0, 5).map(news =>
            `- [t=${news.time_index}] ${news.asset_code || 'GLOBAL'}: ${news.headline}`
        );
        const transactionLines = (portfolio.transaction_log || []).slice(0, 8).map(log =>
            `- [t=${log.time}] ${log.description}: ${this._formatSigned(log.amount)}`
        );
        const marketLines = marketSummary.map(item =>
            `- ${item.name || item.code} (${item.code}): ${Number(item.latest_price || 0).toFixed(4)}，24h ${this._formatSigned(item.change_24h_pct)}%`
        );
        const totalNetWorth = this._calculatePortfolioMarkedValue(portfolio);

        const lines = [
            '【SillyView 市场同步摘要】',
            '用途：这是给普通对话 AI 阅读的市场状态摘要，用于让角色知道交易世界发生了什么。不要把它当作用户发言。',
            '',
            `时间：${market.current_datetime || '未知'} / ${market.current_period || '未知'} / ${market.current_season || '未知'} / 天气：${market.current_weather || '未知'}`,
            `市场状态：${market.market_status || 'OPEN'}，市场性格：${market.personality_state || '未知'}，距离关键时刻剩余 ${market.remaining_candles ?? '未知'} 根K线。`,
            '',
            '账户：',
            `- 现金：${Number(portfolio.cash || 0).toFixed(2)}`,
            `- 债务：${Number(portfolio.debt || 0).toFixed(2)}`,
            `- 估算净值：${Number(totalNetWorth || 0).toFixed(2)}`,
            '',
            '持仓：',
            ...this._buildPositionSummary(portfolio),
            '',
            '市场价格：',
            ...marketLines,
            '',
            '最新市场新闻：',
            ...(newsLines.length > 0 ? newsLines : ['- 暂无新闻。']),
            '',
            '近期资金/交易记录：',
            ...(transactionLines.length > 0 ? transactionLines : ['- 暂无记录。']),
            '',
            '对话使用建议：角色可以自然提及以上市场状态、盈亏压力、债务压力、新闻影响，但不要在普通对话中擅自输出市场指令，除非剧情确实需要触发财务或市场命令。',
        ];

        await this.updateState(keys.dialogue_context, context => ({
            ...(context && typeof context === 'object' && !Array.isArray(context) ? context : {}),
            comment: "这是给普通对话 AI 阅读的市场同步摘要。请按顺序阅读 summary 数组，不要把它当作用户发言。",
            updated_at: market.current_time_index || 0,
            summary: lines,
        }));
    }

    async getMarketWorldbookContext() {
        const targetNames = this.config.market_context_worldbooks || [];
        if (targetNames.length === 0) return '';

        try {
            const charBooks = await this.th.getCharWorldbookNames('current');
            const attachedNames = [
                charBooks.primary,
                ...(charBooks.additional || []),
            ].filter(Boolean);

            const allWorldbooks = await this.th.getWorldbookNames();
            const namesToRead = targetNames.filter(name => attachedNames.includes(name) || allWorldbooks.includes(name));

            const chunks = [];
            for (const worldbookName of namesToRead) {
                const entries = await this.th.getWorldbook(worldbookName);
                const enabledEntries = entries.filter(entry => entry.enabled && entry.content?.trim());
                const sourceEntries = enabledEntries.length > 0
                    ? enabledEntries
                    : entries.filter(entry => entry.content?.trim());

                sourceEntries.forEach(entry => {
                    chunks.push(`### ${worldbookName} / ${entry.name}\n${entry.content.trim()}`);
                });
            }

            return chunks.join('\n\n').slice(0, 12000);
        } catch (error) {
            this.logger.warn('读取市场附加世界书失败:', error);
            return '';
        }
    }

    getActionsThisTurn() {
        const portfolio = this._stateCache.get(this.config.world_book_keys.player_portfolio);
        return portfolio?.actions_this_turn || [];
    }

    clearActionsThisTurn() {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this._stateCache.get(portfolioKey);
        if (portfolio) {
            portfolio.actions_this_turn = [];
            this._stateCache.set(portfolioKey, portfolio);
        }
    }

    isQuickModeEnabled() {
        const portfolio = this.getState(this.config.world_book_keys.player_portfolio);
        return portfolio?.isQuickModeEnabled ?? false;
    }

    async setQuickModeEnabled(isEnabled) {
        await this.updateState(this.config.world_book_keys.player_portfolio, (portfolio) => {
            portfolio.isQuickModeEnabled = isEnabled;
            return portfolio;
        });
    }

    _getTradeConfig(assetCode) {
        return this.config.asset_definitions[assetCode]?.trade_config || {
            spread_bps: 5,
            slippage_bps: 2,
            fee_rate: 0.001,
            maintenance_margin_rate: 0.01,
        };
    }

    _calculateExecutionPrice(assetCode, intent, basePrice) {
        const tradeConfig = this._getTradeConfig(assetCode);
        const spreadBps = tradeConfig.spread_bps || 0;
        const slippageBps = tradeConfig.slippage_bps || 0;
        const oneSideCost = ((spreadBps / 2) + slippageBps) / 10000;
        const isBuySide = ['open_long', 'add_long', 'close_short'].includes(intent);
        const multiplier = isBuySide ? 1 + oneSideCost : 1 - oneSideCost;
        return Math.max(basePrice * multiplier, 0.000001);
    }

    _recordTradeTransaction(portfolio, description, amount) {
        const market = this.getState(this.config.world_book_keys.global_market);
        const time = market ? market.current_time_index : 0;
        if (!portfolio.transaction_log) portfolio.transaction_log = [];
        portfolio.transaction_log.unshift({ time, description, amount });
        if (portfolio.transaction_log.length > 100) portfolio.transaction_log.pop();
    }

    async executeAndRecordTrade(intent, amount, assetCode, executionPrice = null, leverage = 1) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const assetDataKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        let portfolio = this._stateCache.get(portfolioKey);
        let assetData = this._stateCache.get(assetDataKey);
        if (!portfolio || !assetData) return false;

        // **FIX**: Ensure portfolio.assets exists to prevent crashes on old save data.
        if (!portfolio.assets) {
            portfolio.assets = {};
        }

        const isLeveragedTrade = leverage > 1;
        const lastCandle = assetData.kline_hourly.slice(-1)[0];
        const rawPrice = executionPrice !== null ? executionPrice : lastCandle.close;
        const price = this._calculateExecutionPrice(assetCode, intent, rawPrice);
        const position = this.positionCalculator.calculate(assetCode, portfolio);
        const tradeConfig = this._getTradeConfig(assetCode);
        const totalPositionValue = intent.startsWith('close') ? position.positionValue : amount * leverage;
        const fee = totalPositionValue * (tradeConfig.fee_rate ?? 0.001);
        let actionText = '';
        
        portfolio.cash = portfolio.cash || 0;

        switch (intent) {
            case 'open_long':
                if (position.type !== null) { this.dependencies.win.toastr.warning("已有持仓，无法开新仓。请先平仓或加仓。"); return false; }
                // Fallthrough to add_long logic
            case 'add_long':
                if (position.type === 'short') { this.dependencies.win.toastr.warning("无法做多：当前持有空头仓位。"); return false; }
                if (portfolio.cash < amount + fee) { this.dependencies.win.toastr.warning("交易失败：现金不足以支付保证金和手续费。"); return false; }
                
                portfolio.cash -= (amount + fee);
                if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
                
                portfolio.assets[assetCode].trades.push({ time: lastCandle.time, price, amount, type: 'long', leverage });
                
                actionText = (intent === 'open_long') 
                    ? `开多 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`
                    : `加仓多 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`;

                this._recordTradeTransaction(portfolio, actionText, -amount);
                this._recordTradeTransaction(portfolio, `交易手续费`, -fee);
                break;
            
            case 'open_short':
                 if (position.type !== null) { this.dependencies.win.toastr.warning("已有持仓，无法开新仓。请先平仓或加仓。"); return false; }
                // Fallthrough
            case 'add_short':
                if (position.type === 'long') { this.dependencies.win.toastr.warning("无法做空：当前持有多头仓位。"); return false; }
                
                if (portfolio.cash < amount + fee) { this.dependencies.win.toastr.warning("交易失败：现金不足以支付保证金和手续费。"); return false; }
                
                portfolio.cash -= (amount + fee);
                if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
                
                portfolio.assets[assetCode].trades.push({ time: lastCandle.time, price, amount, type: 'short', leverage });
                
                actionText = (intent === 'open_short') 
                    ? `开空 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`
                    : `加仓空 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`;

                this._recordTradeTransaction(portfolio, actionText, -amount);
                this._recordTradeTransaction(portfolio, `交易手续费`, -fee);
                break;

            case 'close_long':
                if (position.type !== 'long') { this.dependencies.win.toastr.warning("交易失败：没有多头仓位可以平仓。"); return false; }
                const pnl_long = (price - position.avgEntryPrice) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl_long - fee;
                this._recordTradeTransaction(portfolio, `平多仓 ${assetCode}`, position.totalAmount + pnl_long);
                this._recordTradeTransaction(portfolio, `交易手续费`, -fee);
                this._recordTradeTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl_long);
                portfolio.assets[assetCode].trades = [];
                actionText = `平多 ${assetCode}`;
                break;

            case 'close_short':
                if (position.type !== 'short') { this.dependencies.win.toastr.warning("交易失败：没有空头仓位可以平仓。"); return false; }
                const pnl_short = (position.avgEntryPrice - price) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl_short - fee;
                this._recordTradeTransaction(portfolio, `平空仓 ${assetCode}`, position.totalAmount + pnl_short);
                this._recordTradeTransaction(portfolio, `交易手续费`, -fee);
                this._recordTradeTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl_short);
                portfolio.assets[assetCode].trades = [];
                actionText = `平空 ${assetCode}`;
                break;

            default:
                this.logger.error("未知的交易意图:", intent);
                return false;
        }

        if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
        portfolio.actions_this_turn.push({ 
            id: Date.now(), 
            text: actionText, 
            executedAt: price,
            intent: intent,
            amount: amount,
            leverage: leverage,
            assetCode: assetCode,
        });

        this._stateCache.set(portfolioKey, portfolio);
        return true;
    }
    
    async liquidatePosition(assetCode, liquidationPrice) {
        this.dependencies.win.toastr.error(`${assetCode} 仓位已被强制平仓！`, "爆仓！");
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        let portfolio = this.getState(portfolioKey);
        const position = this.positionCalculator.calculate(assetCode, portfolio);

        const marginLost = position.totalAmount;
        await this.logTransaction(`爆仓强平 (${assetCode})`, -marginLost, true);
        
        // **FIX**: Added guard to prevent crash if portfolio.assets is missing.
        if (portfolio.assets && portfolio.assets[assetCode]) {
            portfolio.assets[assetCode].trades = [];
        }
        
        this._stateCache.set(portfolioKey, portfolio);
        await this.saveAllEntries();
    }
    
    async takeLoan(amount) {
        await this.updateState(this.config.world_book_keys.player_portfolio, p => {
            p.cash = (p.cash || 0) + amount;
            p.debt = (p.debt || 0) + amount;
            return p;
        });
        await this.logTransaction('申请贷款', amount, false);
        this.dependencies.win.toastr.success(`成功贷款 ${amount.toFixed(2)} 信用点。`);
    }

    async repayLoan(amount) {
        await this.updateState(this.config.world_book_keys.player_portfolio, p => {
            p.cash = (p.cash || 0) - amount;
            p.debt = (p.debt || 0) - amount;
            return p;
        });
        await this.logTransaction('偿还贷款', -amount, false);
        this.dependencies.win.toastr.info(`已偿还 ${amount.toFixed(2)} 信用点贷款。`);
    }

    async grantLoanByAI(amount, reason) {
        await this.updateState(this.config.world_book_keys.player_portfolio, p => {
            p.cash = (p.cash || 0) + amount;
            p.debt = (p.debt || 0) + amount;
            return p;
        });
        await this.logTransaction(`AI贷款: ${reason}`, amount, false);
        this.dependencies.win.toastr.info(`AI为你提供了一笔 ${amount.toFixed(2)} 信用点的贷款。`, "融资机会");
    }
    
    async addDebtOnly(amount, reason) {
        await this.updateState(this.config.world_book_keys.player_portfolio, p => {
            p.debt = (p.debt || 0) + amount;
            return p;
        });
        await this.logTransaction(`AI增加债务: ${reason}`, 0, true);
        this.dependencies.win.toastr.warning(`你的债务增加了 ${amount.toFixed(2)} 信用点。`, "债务增加");
    }

    async forceRepayLoanByAI(amount, reason) {
        const portfolio = this.getState(this.config.world_book_keys.player_portfolio);
        if (!portfolio || (portfolio.cash || 0) < amount) {
            this.dependencies.win.toastr.error(`AI要求偿还 ${amount.toFixed(2)} 贷款，但你的现金不足！`);
            return;
        }
        await this.updateState(this.config.world_book_keys.player_portfolio, p => {
            p.cash = (p.cash || 0) - amount;
            p.debt = (p.debt || 0) - amount;
            return p;
        });
        await this.logTransaction(`AI强制还款: ${reason}`, -amount, false);
        this.dependencies.win.toastr.warning(`AI强制你偿还了 ${amount.toFixed(2)} 信用点的贷款。`, "债务催收");
    }
    
    async accrueInterest() {
        const portfolio = this.getState(this.config.world_book_keys.player_portfolio);
        if (portfolio && (portfolio.debt || 0) > 0) {
            const interest = portfolio.debt * this.config.loan_config.daily_interest_rate;
            await this.updateState(this.config.world_book_keys.player_portfolio, p => {
                p.debt = (p.debt || 0) + interest;
                return p;
            });
            await this.logTransaction('贷款利息', -interest, false);
            this.logger.log(`产生了 ${interest.toFixed(2)} 的贷款利息。`);
        }
    }
    
    async updateAssetCandles(assetCode, newCandles) {
        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        await this.updateState(assetKey, assetData => {
            if (!assetData) return null;
            assetData.kline_hourly.push(...newCandles);
            assetData.current_price = newCandles[newCandles.length - 1].close;
            return assetData;
        });
    }

    async aggregateHourlyToDaily(assetCode, hoursInDay) {
        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        await this.updateState(assetKey, assetData => {
            if (!assetData.kline_hourly || assetData.kline_hourly.length < hoursInDay) return assetData;

            const lastDayStartIndex = assetData.kline_hourly.length - hoursInDay;
            if (lastDayStartIndex < 0) return assetData;
            const lastHourlyCandles = assetData.kline_hourly.slice(lastDayStartIndex);

            const firstCandle = lastHourlyCandles[0];
            const lastCandle = lastHourlyCandles[lastHourlyCandles.length - 1];

            const dailyCandle = {
                time: Math.floor(firstCandle.time / hoursInDay),
                open: firstCandle.open,
                high: Math.max(...lastHourlyCandles.map(c => c.high)),
                low: Math.min(...lastHourlyCandles.map(c => c.low)),
                close: lastCandle.close,
                volume: lastHourlyCandles.reduce((sum, c) => sum + c.volume, 0),
            };

            if (!assetData.kline_daily) assetData.kline_daily = [];
            assetData.kline_daily.push(dailyCandle);
            this.logger.success(`Aggregated daily candle for ${assetCode} on day ${dailyCandle.time}.`);
            return assetData;
        });
    }

    async recordAssetHistory() {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this.getState(portfolioKey);
        if (!portfolio) return;
    
        let totalAssetValue = 0;
        if (portfolio.assets) {
            for (const assetCode in portfolio.assets) {
                const position = this.positionCalculator.calculate(assetCode, portfolio);
                if (position.totalAmount > 0) {
                    const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
                    const lastPrice = assetData?.current_price ?? 0;
                    if (position.type === 'short') {
                        const pnl = (position.avgEntryPrice - lastPrice) * position.totalShares;
                        totalAssetValue += position.totalAmount + pnl;
                    } else { // long
                        const pnl = (lastPrice - position.avgEntryPrice) * position.totalShares;
                        totalAssetValue += position.totalAmount + pnl;
                    }
                }
            }
        }
    
        const totalValue = (portfolio.cash || 0) + totalAssetValue - (portfolio.debt || 0);
    
        await this.updateState(portfolioKey, p => {
            if (!p.asset_history) p.asset_history = [];
            const market = this.getState(this.config.world_book_keys.global_market);
            const time = market ? market.current_time_index : Date.now();
            const newHistoryPoint = { time, value: totalValue };
    
            const lastEntry = p.asset_history[p.asset_history.length - 1];
            if (lastEntry && lastEntry.time === newHistoryPoint.time) {
                lastEntry.value = newHistoryPoint.value;
            } else {
                p.asset_history.push(newHistoryPoint);
            }
            
            if (p.asset_history.length > 365) p.asset_history.shift();
            return p;
        });
    }

    async logTransaction(description, amount, isTradeRelated = false) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const marketKey = this.config.world_book_keys.global_market;
        const market = this.getState(marketKey);
        const time = market ? market.current_time_index : 0;
    
        await this.updateState(portfolioKey, p => {
            if (!p.transaction_log) p.transaction_log = [];
            p.transaction_log.unshift({ time, description, amount });
            if (p.transaction_log.length > 100) p.transaction_log.pop();
            if(!isTradeRelated) {
                 p.cash = (p.cash || 0) + amount;
            }
            return p;
        });
    }
}
