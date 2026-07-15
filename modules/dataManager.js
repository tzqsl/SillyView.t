/**
 * SillyView - Data Manager (v4.1 - Trading Costs & Quick Mode)
 * Manages all interactions with SillyTavern's World Book, state caching, and snapshots.
 */
'use strict';

import { Logger } from './logger.js';
import { SillyViewConfig } from './config.js';

export class DataManager {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.th = dependencies.th;
        this.logger = dependencies.logger;
        this.config = dependencies.config;

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
            try {
                this._stateCache.set(entry.name, JSON.parse(entry.content));
            } catch (e) {
                this.logger.error(`解析条目 "${entry.name}" 失败:`, e);
            }
        }
        this.logger.success("所有游戏数据已加载到缓存。");
    }

    getState(key) {
        return this.dependencies.win._.cloneDeep(this._stateCache.get(key) || null);
    }

    getRawState() {
        return this._stateCache;
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

    async saveAllEntries() {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) return;

        Logger.log(`Saving all ${this._stateCache.size} state entries to "${lorebookName}"...`);
        await this.th.updateWorldbookWith(lorebookName, (entries) => {
            for (const entry of entries) {
                if (this._stateCache.has(entry.name)) {
                    entry.content = JSON.stringify(this._stateCache.get(entry.name), null, 2);
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

        const entriesTemplate = [
            { name: keys.config, content: JSON.stringify(defaults.config, null, 2) },
            { name: keys.global_market, content: JSON.stringify(defaults.global_market, null, 2) },
            { name: keys.player_portfolio, content: JSON.stringify(defaults.player_portfolio, null, 2) },
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
                    content: JSON.stringify(initialAssetData, null, 2)
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

        this.logger.success("初始世界书条目创建成功。正在直接加载状态到缓存...");

        this._stateCache.clear();
        for (const entry of entriesTemplate) {
            try {
                this._stateCache.set(entry.name, JSON.parse(entry.content));
            } catch (e) {
                this.logger.error(`解析新创建的条目 "${entry.name}" 失败:`, e);
            }
        }
        this.hasGameBook = true;

        this.logger.success("状态已加载到缓存，正在渲染主界面...");
        this.ui.renderMainInterface();
    }

    createSnapshot() {
        return this.dependencies.win._.cloneDeep(this._stateCache);
    }

    restoreStateFromSnapshot(snapshot) {
        this._stateCache = this.dependencies.win._.cloneDeep(snapshot);
        Logger.log("State restored from snapshot.");
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
        Logger.log("Cleared actions for this turn.");
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
        Logger.log(`Quick Mode state saved: ${isEnabled}`);
    }

    executeAndRecordTrade(type, amount, assetCode) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const assetDataKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;

        let portfolio = this._stateCache.get(portfolioKey);
        let assetData = this._stateCache.get(assetDataKey);

        if (!portfolio || !assetData) {
            this.logger.error("交易失败：缺少投资组合或资产数据。");
            return false;
        }

        const fee = amount * 0.005;

        const lastCandle = assetData.kline_hourly.slice(-1)[0];
        const price = lastCandle.close;

        const trades = portfolio.assets[assetCode]?.trades || [];
        let totalAmount = 0, totalShares = 0;
        trades.forEach(t => {
            const shares = t.amount / t.price;
            totalAmount += (t.type === 'buy' ? t.amount : -t.amount);
            totalShares += (t.type === 'buy' ? shares : -shares);
        });
        const avgEntryPrice = totalShares > 0 ? totalAmount / totalShares : 0;

        if (type === 'buy') {
            if (portfolio.cash < amount + fee) {
                this.dependencies.win.toastr.warning("交易失败：现金不足以完成购买及支付手续费。");
                return false;
            }
            portfolio.cash -= (amount + fee);
        } else { // sell
            if (totalAmount < amount) {
                this.dependencies.win.toastr.warning("交易失败：持仓不足。");
                return false;
            }
            const currentValue = amount * (price / avgEntryPrice);
            portfolio.cash += currentValue;
            portfolio.cash -= fee;
        }

        if (!portfolio.assets[assetCode]) {
            portfolio.assets[assetCode] = { trades: [] };
        }
        portfolio.assets[assetCode].trades.push({ time: lastCandle.time, price, amount, type });

        if (!portfolio.actions_this_turn) {
            portfolio.actions_this_turn = [];
        }
        portfolio.actions_this_turn.push({ id: Date.now(), type, amount, assetCode });

        this._stateCache.set(portfolioKey, portfolio);
        this.logger.log(`交易已执行并记录: ${type} ${amount} of ${assetCode} @ ${price}`);
        this.dependencies.win.toastr.info(`支付手续费 ${fee.toFixed(2)} 信用点。`);
        return true;
    }
    
    async advanceAssetInBackground(assetCode, hours) {
        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        await this.updateState(assetKey, assetData => {
            if (!assetData) return null;

            const assetDef = SillyViewConfig.asset_definitions[assetCode];
            const params = assetDef.quick_mode_params;

            for (let i = 0; i < hours; i++) {
                const lastCandle = assetData.kline_hourly.slice(-1)[0];
                const changePercent = (Math.random() - 0.5) * params.volatility + params.drift;
                const newClose = lastCandle.close * (1 + changePercent);
                const high = Math.max(lastCandle.close, newClose) * (1 + Math.random() * (params.volatility / 4));
                const low = Math.min(lastCandle.close, newClose) * (1 - Math.random() * (params.volatility / 4));

                const newCandle = {
                    time: lastCandle.time + 1,
                    open: lastCandle.close,
                    high,
                    low,
                    close: newClose,
                    volume: Math.floor(Math.random() * 500000) + 100000,
                    pattern: 'background_sim'
                };
                assetData.kline_hourly.push(newCandle);
                assetData.current_price = newClose;
            }
            this.logger.log(`为 ${assetCode} 在后台模拟了 ${hours} 小时。`);
            return assetData;
        });
    }


    async aggregateHourlyToDaily(assetCode, hoursInDay) {
        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;

        await this.updateState(assetKey, assetData => {
            if (!assetData.kline_hourly || assetData.kline_hourly.length < hoursInDay) {
                this.logger.warn(`Not enough hourly data to aggregate for ${assetCode}`);
                return assetData;
            }

            const lastDayStartIndex = assetData.kline_hourly.length - hoursInDay;
            if (lastDayStartIndex < 0) {
                this.logger.warn(`Could not find start index for daily aggregation for ${assetCode}`);
                return assetData;
            }

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

            if (!assetData.kline_daily) {
                assetData.kline_daily = [];
            }
            assetData.kline_daily.push(dailyCandle);
            this.logger.success(`Aggregated daily candle for ${assetCode} on day ${dailyCandle.time}.`);
            return assetData;
        });
    }
}
