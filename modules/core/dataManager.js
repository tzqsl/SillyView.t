/**
 * SillyView - Data Manager (v6.3 - Robustness Hotfix)
 * Manages all interactions with SillyTavern's World Book, state caching, and snapshots.
 */
'use strict';

import { Logger } from '../logger.js';
import { SillyViewConfig } from '../config.js';

const LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX = 'SillyView_account_';

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
        this.contextEntriesEnsuredFor = null;
    }

    _ensureAssetDataShape(assetData) {
        if (!assetData || typeof assetData !== 'object') return assetData;

        if (!Array.isArray(assetData.kline_hourly)) assetData.kline_hourly = [];
        if (!Array.isArray(assetData.kline_daily)) assetData.kline_daily = [];
        if (!Array.isArray(assetData.kline_minute)) {
            const baseCandle = assetData.kline_hourly[assetData.kline_hourly.length - 1] || {
                time: 0,
                open: assetData.current_price || 0,
                high: assetData.current_price || 0,
                low: assetData.current_price || 0,
                close: assetData.current_price || 0,
                volume: 0,
            };
            const minuteTime = Number.isFinite(baseCandle.time) ? baseCandle.time * 60 : 0;
            assetData.kline_minute = [{
                time: minuteTime,
                open: baseCandle.close,
                high: baseCandle.close,
                low: baseCandle.close,
                close: baseCandle.close,
                volume: 0,
                pattern: 'migration_seed',
            }];
        }

        const lastMinute = assetData.kline_minute[assetData.kline_minute.length - 1];
        const lastHourly = assetData.kline_hourly[assetData.kline_hourly.length - 1];
        assetData.current_price = lastMinute?.close ?? lastHourly?.close ?? assetData.current_price ?? 0;
        return assetData;
    }

    _trimCandles(assetData) {
        const configState = this._stateCache.get(this.config.world_book_keys.config) || {};
        const maxHourly = configState.max_hourly_records || this.config.default_game_state.config.max_hourly_records || 240;
        const maxMinute = configState.max_minute_records || this.config.default_game_state.config.max_minute_records || 720;

        if (Array.isArray(assetData.kline_hourly) && assetData.kline_hourly.length > maxHourly) {
            assetData.kline_hourly = assetData.kline_hourly.slice(-maxHourly);
        }
        if (Array.isArray(assetData.kline_minute) && assetData.kline_minute.length > maxMinute) {
            assetData.kline_minute = assetData.kline_minute.slice(-maxMinute);
        }
    }

    async _getLorebookName() {
        const charName = await this.th.substitudeMacros('{{char}}');
        if (!charName || charName === '{{char}}') return null;
        return `${this.config.extension_name}_${charName}`;
    }

    async _getCharacterName() {
        const charName = await this.th.substitudeMacros('{{char}}');
        return (!charName || charName === '{{char}}') ? 'current' : charName;
    }

    _sanitizeName(value) {
        return String(value || 'account')
            .trim()
            .replace(/[\\/:*?"<>|#\[\]{}]/g, '_')
            .replace(/\s+/g, '_')
            .slice(0, 48) || 'account';
    }

    _hashString(value) {
        let hash = 0;
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    async loadInitialState() {
        this.logger.log("正在加载初始状态...");
        this.ui.renderInitializationProgress({
            step: '准备',
            title: '正在加载 SillyView',
            detail: '正在读取当前角色和绑定世界书。',
            percent: 5,
        });
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) {
            this.ui.renderError("无法确定角色名称。");
            return;
        }

        const allBooks = await this.th.getWorldbookNames();
        this.hasGameBook = allBooks.includes(lorebookName);

        if (this.hasGameBook) {
            this.logger.log(`游戏世界书 "${lorebookName}" 已找到，正在加载数据...`);
            this.ui.renderInitializationProgress({
                step: '世界书',
                title: '正在加载交易世界',
                detail: `已找到 ${lorebookName}，正在读取状态条目。`,
                percent: 15,
            });
            await this.loadAllEntries(lorebookName);
            this.ui.renderInitializationProgress({
                step: '上下文',
                title: '正在检查上下文条目',
                detail: '正在确保对话摘要、K线摘要和市场目标条目存在。',
                percent: 28,
            });
            await this.ensureRequiredContextEntries(lorebookName);
            this.ui.renderInitializationProgress({
                step: '多账户',
                title: '正在同步多账户',
                detail: '正在扫描开户行格式，并更新 SillyView_accounts。',
                percent: 40,
            });
            await this.autoDiscoverAndSyncManagedAccounts();
            this.ui.renderInitializationProgress({
                step: '摘要',
                title: '正在更新 AI 上下文',
                detail: '正在写入市场摘要、账目和 K线判断上下文。',
                percent: 52,
            });
            await this.updateDialogueContext();
            await this.runInitialBootstrapIfNeeded();
            this.ui.renderInitializationProgress({
                step: '完成',
                title: '初始化完成',
                detail: '正在打开交易面板。',
                percent: 100,
            });
            this.ui.renderMainInterface();
        } else {
            await this.autoDiscoverAndSyncManagedAccounts();
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
            let parsed = this._parseEntryContent(entry.content);
            if (entry.name?.startsWith(this.config.world_book_keys.asset_prefix)) {
                parsed = this._ensureAssetDataShape(parsed);
            }
            this._stateCache.set(entry.name, parsed);
        }
        this.isInitialized = true;
        this.logger.success("所有游戏数据已加载到缓存。");
    }

    async ensureStateLoaded() {
        if (this.isInitialized && this.hasGameBook && this._stateCache.size > 0) {
            const lorebookName = await this._getLorebookName();
            if (lorebookName) await this.ensureRequiredContextEntries(lorebookName);
            return true;
        }

        const lorebookName = await this._getLorebookName();
        if (!lorebookName) return false;

        const allBooks = await this.th.getWorldbookNames();
        if (!allBooks.includes(lorebookName)) return false;

        this.hasGameBook = true;
        await this.loadAllEntries(lorebookName);
        await this.ensureRequiredContextEntries(lorebookName);
        return true;
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
            let entry = entries.find(e => e.name === key);
            if (!entry) {
                entry = { name: key, content: '', enabled: true };
                this._insertWorldbookEntry(entries, entry, this._getPreferredAfterKey(key));
            }
            if (entry) {
                entry.content = JSON.stringify(newState, null, 2);
                entry.enabled = true;
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
                this._insertWorldbookEntry(entries, entry, this._getPreferredAfterKey(key));
            }
            entry.content = content;
            entry.enabled = true;
            return entries;
        });
    }

    async ensureDialogueContextEntry(lorebookName) {
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.dialogue_context,
            this.config.default_game_state.dialogue_context
        );
    }

    _getPreferredAfterKey(key) {
        const keys = this.config.world_book_keys;
        if (key === keys.kline_context) return keys.dialogue_context;
        if (key === keys.market_targets) return keys.kline_context;
        return null;
    }

    _insertWorldbookEntry(entries, newEntry, afterKey = null) {
        const afterIndex = afterKey
            ? entries.findIndex(item => item.name === afterKey)
            : -1;

        if (afterIndex >= 0) {
            entries.splice(afterIndex + 1, 0, newEntry);
        } else {
            entries.push(newEntry);
        }
    }

    async ensureRequiredContextEntries(lorebookName) {
        const keys = this.config.world_book_keys;
        const needsEnsure =
            this.contextEntriesEnsuredFor !== lorebookName ||
            !this._stateCache.has(keys.dialogue_context) ||
            !this._stateCache.has(keys.kline_context) ||
            !this._stateCache.has(keys.market_targets);

        if (!needsEnsure) return;

        await this.ensureContextEntries(lorebookName);
        this.contextEntriesEnsuredFor = lorebookName;
    }

    async ensureContextEntries(lorebookName) {
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.dialogue_context,
            this.config.default_game_state.dialogue_context
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.kline_context,
            this.config.default_game_state.kline_context,
            { afterKey: this.config.world_book_keys.dialogue_context }
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.market_targets,
            this.config.default_game_state.market_targets,
            { afterKey: this.config.world_book_keys.kline_context }
        );
    }

    async ensureContextEntry(lorebookName, key, defaultState, options = {}) {
        const defaultContent = JSON.stringify(defaultState, null, 2);

        await this.th.updateWorldbookWith(lorebookName, entries => {
            const entry = entries.find(item => item.name === key);
            if (entry) {
                entry.enabled = true;
            } else {
                const newEntry = { name: key, content: defaultContent, enabled: true };
                this._insertWorldbookEntry(entries, newEntry, options.afterKey);
            }
            return entries;
        });

        if (!this._stateCache.has(key)) {
            this._stateCache.set(key, this.dependencies.win._.cloneDeep(defaultState));
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

    _normalizeBackgroundAISettings(settings = {}) {
        const normalized = {
            ...this.config.background_ai_defaults,
            ...(settings || {}),
        };
        delete normalized.proxy_preset;
        return normalized;
    }

    async createInitialWorldState(options = {}) {
        const lorebookName = await this._getLorebookName();
        if (!lorebookName) {
            this.logger.error("无法创建世界书：未选择角色。");
            return;
        }

        this.ui.renderInitializationProgress({
            step: '创建',
            title: '正在创建 SillyView 世界书',
            detail: '正在生成初始账户、行情和上下文条目。',
            percent: 8,
        });
        this.logger.log(`正在创建新的游戏世界书: "${lorebookName}"...`);
        const defaults = this.config.default_game_state;
        const keys = this.config.world_book_keys;
        const initialConfig = {
            ...defaults.config,
            background_ai: this._normalizeBackgroundAISettings(options.backgroundAI || defaults.config.background_ai),
        };

        // Initialize with a random candle count for immediate quick mode use
        const initialGlobalMarket = {
            ...defaults.global_market,
            remaining_candles: Math.floor(Math.random() * 30) + 1
        };

        const entriesTemplate = [
            { name: keys.config, content: JSON.stringify(initialConfig, null, 2), enabled: true },
            { name: keys.global_market, content: JSON.stringify(initialGlobalMarket, null, 2), enabled: true },
            { name: keys.player_portfolio, content: JSON.stringify(defaults.player_portfolio, null, 2), enabled: true },
            { name: keys.ai_context, content: JSON.stringify(defaults.ai_context, null, 2), enabled: true },
            { name: keys.dialogue_context, content: JSON.stringify(defaults.dialogue_context, null, 2), enabled: true },
            { name: keys.kline_context, content: JSON.stringify(defaults.kline_context, null, 2), enabled: true },
            { name: keys.market_targets, content: JSON.stringify(defaults.market_targets, null, 2), enabled: true },
        ];

        initialConfig.available_assets.forEach(assetCode => {
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
                    kline_minute: [{
                        time: 0,
                        open: assetDef.initial_price,
                        high: assetDef.initial_price,
                        low: assetDef.initial_price,
                        close: assetDef.initial_price,
                        volume: 0,
                        pattern: 'seed',
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
        this.ui.renderInitializationProgress({
            step: '绑定',
            title: '正在绑定世界书',
            detail: `正在把 ${lorebookName} 绑定到当前角色卡附加世界书。`,
            percent: 25,
        });

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
        this.isInitialized = true;
        this.contextEntriesEnsuredFor = lorebookName;
        this.ui.renderInitializationProgress({
            step: '多账户',
            title: '正在扫描开户行账户',
            detail: '正在同步 SillyView_accounts 和角色专属账户状态词条。',
            percent: 38,
        });
        await this.autoDiscoverAndSyncManagedAccounts();
        this.ui.renderInitializationProgress({
            step: '摘要',
            title: '正在写入初始 AI 上下文',
            detail: '正在生成市场摘要、K线摘要和账目查询条目。',
            percent: 50,
        });
        await this.updateAIContext();
        await this.runInitialBootstrapIfNeeded();
        this.ui.renderInitializationProgress({
            step: '完成',
            title: '初始化完成',
            detail: '正在打开交易面板。',
            percent: 100,
        });
        this.ui.renderMainInterface();
    }

    async runInitialBootstrapIfNeeded() {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config) || {};
        if (configState.initial_bootstrap_done) return false;

        const app = this.dependencies.app;
        if (!app?.runInitialBootstrapTurn) {
            this.logger.warn('初始化预热流程不可用，跳过自动推进。');
            return false;
        }

        this.logger.log('正在执行初始化预热：自动快速推进一天，并发送一次后台AI结束回合提示词。');
        this.ui.renderInitializationProgress({
            step: '预热',
            title: '正在预热市场',
            detail: '即将快速推进一天行情，然后发送一次后台 AI 回合结束提示词。',
            percent: 60,
        });
        try {
            await app.runInitialBootstrapTurn();
            this.ui.renderInitializationProgress({
                step: '保存',
                title: '正在保存初始化结果',
                detail: '后台 AI 已返回，正在写入完成标记和最新世界书条目。',
                percent: 94,
            });
            await this.updateState(keys.config, config => ({
                ...(config || {}),
                initial_bootstrap_done: true,
                initial_bootstrap_at: Date.now(),
                initial_bootstrap_error: null,
            }));
            return true;
        } catch (error) {
            this.logger.error('初始化预热失败。', error);
            this.dependencies.win.toastr?.error(`初始化预热失败: ${error.message || error}`);
            await this.updateState(keys.config, config => ({
                ...(config || {}),
                initial_bootstrap_error: String(error.message || error),
                initial_bootstrap_failed_at: Date.now(),
            }));
            return false;
        }
    }
    
    async resetAllData() {
        this.logger.warn("正在重置所有SillyView数据...");
        const configState = this.getState(this.config.world_book_keys.config) || {};
        const preservedBackgroundAI = this._normalizeBackgroundAISettings(configState.background_ai);
        await this.createInitialWorldState({ backgroundAI: preservedBackgroundAI }); // Re-running the creation process effectively resets everything.
        this.dependencies.win.toastr.success("所有数据已重置到初始状态，后台模型设置已保留。");
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

    _normalizeMarketTargetsState(state = {}) {
        return {
            comment: state.comment || this.config.default_game_state.market_targets.comment,
            updated_at: state.updated_at || 0,
            updated_minute_at: state.updated_minute_at || 0,
            targets: state.targets && typeof state.targets === 'object' ? state.targets : {},
        };
    }

    getMarketTargets() {
        return this._normalizeMarketTargetsState(
            this.getState(this.config.world_book_keys.market_targets) || {}
        );
    }

    _isTargetExpired(target, type, market) {
        if (!target) return true;
        if (type === 'long') return Number(target.end_time) <= Number(market.current_time_index || 0);
        return Number(target.end_minute) <= Number(market.minute_time_index || 0);
    }

    async pruneExpiredMarketTargets() {
        const key = this.config.world_book_keys.market_targets;
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        let changed = false;

        await this.updateState(key, state => {
            const next = this._normalizeMarketTargetsState(state);
            for (const assetCode of Object.keys(next.targets)) {
                const assetTargets = next.targets[assetCode] || {};
                for (const type of ['long', 'short']) {
                    if (this._isTargetExpired(assetTargets[type], type, market)) {
                        delete assetTargets[type];
                        changed = true;
                    }
                }
                if (!assetTargets.long && !assetTargets.short) {
                    delete next.targets[assetCode];
                    changed = true;
                } else {
                    next.targets[assetCode] = assetTargets;
                }
            }
            next.updated_at = market.current_time_index || 0;
            next.updated_minute_at = market.minute_time_index || 0;
            return next;
        });

        return changed;
    }

    async setMarketTarget(assetCode, type, target) {
        if (!this.config.asset_definitions[assetCode] || !['long', 'short'].includes(type)) return false;

        const key = this.config.world_book_keys.market_targets;
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const price = Number(target.target_price);
        if (!Number.isFinite(price) || price <= 0) return false;

        const duration = Math.max(1, Math.floor(Number(target.duration) || 1));
        const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const base = {
            target_price: price,
            pattern: String(target.pattern || (price >= (assetData?.current_price || price) ? 'bull_trend' : 'bear_trend')),
            reason: String(target.reason || 'AI market target'),
            confidence: Math.min(Math.max(Number(target.confidence ?? 0.65), 0), 1),
            created_at: market.current_time_index || 0,
            created_minute_at: market.minute_time_index || 0,
            start_price: Number(assetData?.current_price || price),
        };

        const normalizedTarget = type === 'long'
            ? { ...base, end_time: (market.current_time_index || 0) + duration }
            : { ...base, end_minute: (market.minute_time_index || 0) + duration };

        await this.updateState(key, state => {
            const next = this._normalizeMarketTargetsState(state);
            if (!next.targets[assetCode]) next.targets[assetCode] = {};
            next.targets[assetCode][type] = normalizedTarget;
            next.updated_at = market.current_time_index || 0;
            next.updated_minute_at = market.minute_time_index || 0;
            return next;
        });

        return true;
    }

    async clearMarketTarget(assetCode, type = 'all') {
        const key = this.config.world_book_keys.market_targets;
        const market = this.getState(this.config.world_book_keys.global_market) || {};

        await this.updateState(key, state => {
            const next = this._normalizeMarketTargetsState(state);
            if (assetCode === 'ALL' || assetCode === '*') {
                next.targets = {};
            } else if (next.targets[assetCode]) {
                if (type === 'all') {
                    delete next.targets[assetCode];
                } else {
                    delete next.targets[assetCode][type];
                    if (!next.targets[assetCode].long && !next.targets[assetCode].short) {
                        delete next.targets[assetCode];
                    }
                }
            }
            next.updated_at = market.current_time_index || 0;
            next.updated_minute_at = market.minute_time_index || 0;
            return next;
        });
    }

    getActiveMarketTargetsSummary(assetCodes = null) {
        const state = this.getMarketTargets();
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const selected = assetCodes ? new Set(assetCodes) : null;
        const lines = [];

        for (const assetCode of Object.keys(state.targets || {})) {
            if (selected && !selected.has(assetCode)) continue;
            const assetTargets = state.targets[assetCode] || {};
            const assetName = this.config.asset_definitions[assetCode]?.name || assetCode;
            if (assetTargets.long && !this._isTargetExpired(assetTargets.long, 'long', market)) {
                const remain = Math.max(0, Number(assetTargets.long.end_time || 0) - Number(market.current_time_index || 0));
                lines.push(`${assetName} (${assetCode}) 长线目标: ${Number(assetTargets.long.target_price).toFixed(4)}, 剩余 ${remain} 小时, pattern=${assetTargets.long.pattern}, reason=${assetTargets.long.reason}`);
            }
            if (assetTargets.short && !this._isTargetExpired(assetTargets.short, 'short', market)) {
                const remain = Math.max(0, Number(assetTargets.short.end_minute || 0) - Number(market.minute_time_index || 0));
                lines.push(`${assetName} (${assetCode}) 短线目标: ${Number(assetTargets.short.target_price).toFixed(4)}, 剩余 ${remain} 分钟, pattern=${assetTargets.short.pattern}, reason=${assetTargets.short.reason}`);
            }
        }

        return lines;
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
        await this.pruneExpiredMarketTargets();

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
            active_market_targets: this.getActiveMarketTargetsSummary(availableAssets),
        }));
        await this.updateDialogueContext(marketSummary);
    }

    _formatSigned(value, digits = 2) {
        const number = Number(value || 0);
        return `${number >= 0 ? '+' : ''}${number.toFixed(digits)}`;
    }

    _compactCandle(candle) {
        return [
            candle.time,
            Number(Number(candle.open || 0).toFixed(4)),
            Number(Number(candle.high || 0).toFixed(4)),
            Number(Number(candle.low || 0).toFixed(4)),
            Number(Number(candle.close || 0).toFixed(4)),
        ];
    }

    _buildRecentKlineSnapshot(assetCode, assetData) {
        const mapRecent = candles => (candles || []).slice(-10).map(candle => this._compactCandle(candle));

        return {
            code: assetCode,
            columns: ['t', 'o', 'h', 'l', 'c'],
            m1: mapRecent(assetData?.kline_minute),
            h1: mapRecent(assetData?.kline_hourly),
        };
    }

    _selectKlineContextAssets(availableAssets, portfolio) {
        const selected = new Set();
        if (this.ui?.currentAsset && availableAssets.includes(this.ui.currentAsset)) {
            selected.add(this.ui.currentAsset);
        }

        for (const assetCode of Object.keys(portfolio?.assets || {})) {
            if (availableAssets.includes(assetCode) && (portfolio.assets[assetCode]?.trades || []).length > 0) {
                selected.add(assetCode);
            }
            if (selected.size >= 3) break;
        }

        if (selected.size === 0 && availableAssets.length > 0) {
            selected.add(availableAssets[0]);
        }

        return [...selected].slice(0, 3);
    }

    _buildRecentKlineContext(assetCodes) {
        return assetCodes.map(assetCode => {
            const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
            return this._buildRecentKlineSnapshot(assetCode, assetData);
        });
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
            const riskControls = portfolio.assets?.[assetCode]?.risk_controls || {};
            const takeProfit = Number(riskControls.take_profit);
            const stopLoss = Number(riskControls.stop_loss);
            const riskText = [
                Number.isFinite(takeProfit) && takeProfit > 0 ? `止盈 ${takeProfit.toFixed(4)}` : '止盈 未设置',
                Number.isFinite(stopLoss) && stopLoss > 0 ? `止损 ${stopLoss.toFixed(4)}` : '止损 未设置',
            ].join('，');

            lines.push(`- ${assetCode}: ${direction}${leverage}，保证金 ${position.totalAmount.toFixed(2)}，入场 ${position.avgEntryPrice.toFixed(4)}，现价 ${lastPrice.toFixed(4)}，${riskText}，未实现盈亏 ${this._formatSigned(pnl)} (${this._formatSigned(pnlPct)}%)`);
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

        await this.updateState(keys.dialogue_context, () => ({
            comment: "这是给普通对话 AI 阅读的市场同步摘要。请按顺序阅读 summary 数组，不要把它当作用户发言。",
            updated_at: market.current_time_index || 0,
            summary: lines,
        }));
        await this.updateKlineContext(availableAssets, portfolio, market);
        await this.syncManagedAccountsWorldbook();
    }

    async updateKlineContext(availableAssets = null, portfolio = null, market = null) {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const resolvedAssets = availableAssets || configState?.available_assets || Object.keys(this.config.asset_definitions);
        const resolvedPortfolio = portfolio || this.getState(keys.player_portfolio) || {};
        const resolvedMarket = market || this.getState(keys.global_market) || {};
        const klineAssetCodes = this._selectKlineContextAssets(resolvedAssets, resolvedPortfolio);
        const recentKlines = this._buildRecentKlineContext(klineAssetCodes);

        await this.updateState(keys.kline_context, () => ({
            comment: "Compact K-line context for market judgment. Use columns=[t,o,h,l,c]. This entry is separate from sv_dialogue_context to avoid bloating general dialogue context.",
            updated_at: resolvedMarket.current_time_index || 0,
            updated_minute_at: resolvedMarket.minute_time_index || 0,
            selected_assets: klineAssetCodes,
            assets: recentKlines,
        }));
    }

    _parseAmount(value) {
        if (typeof value === 'number') return value;
        const text = String(value || '').replace(/[,，\s]/g, '');
        const base = parseFloat(text);
        if (!Number.isFinite(base)) return NaN;
        if (text.includes('亿')) return base * 100000000;
        if (text.includes('万')) return base * 10000;
        return base;
    }

    _escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _stripLooseFieldValue(value) {
        return String(value || '')
            .trim()
            .replace(/^[`"'“”‘’]+|[`"'“”‘’，,}]+$/g, '')
            .trim();
    }

    _extractLineField(text, names) {
        for (const name of names) {
            const escapedName = this._escapeRegExp(name);
            const match = String(text || '').match(new RegExp(`["'“”‘’]?${escapedName}["'“”‘’]?\\s*[:：=]\\s*("([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\n\\r;；]+))`, 'i'));
            if (match) return this._stripLooseFieldValue(match[2] || match[3] || match[4] || match[1]);
        }
        return '';
    }

    _parseLooseJsonRecords(content) {
        const text = String(content || '').trim();
        if (!text) return [];

        const sanitize = value => String(value || '')
            .replace(/,\s*([}\]])/g, '$1')
            .trim();
        const normalizeRecords = parsed => Array.isArray(parsed) ? parsed : [parsed];
        const attempts = [
            sanitize(text),
            `[${sanitize(text).replace(/}\s*(?=\{)/g, '},')}]`,
        ];

        for (const candidate of attempts) {
            try {
                return normalizeRecords(JSON.parse(candidate));
            } catch (error) {
                // Continue to looser object extraction below.
            }
        }

        const records = [];
        const objectBlocks = sanitize(text).match(/\{[\s\S]*?\}/g) || [];
        for (const block of objectBlocks) {
            try {
                records.push(JSON.parse(sanitize(block)));
            } catch (error) {
                // Ignore invalid object fragments; text fallback will still run.
            }
        }
        return records;
    }

    _normalizeBankAccountRecord(record, source) {
        if (!record || typeof record !== 'object') return null;
        const owner = record.owner_name || record.owner || record.account_name || record.name || record['户名'] || record['账户名'] || record['姓名'] || record['角色'];
        const bank = record.bank_name || record.bank || record['开户行'] || record['银行'] || record['开户银行'];
        const balance = this._parseAmount(record.balance ?? record.cash ?? record['余额'] ?? record['存款'] ?? record['银行卡余额'] ?? record['现金']);
        const debt = this._parseAmount(record.debt ?? record['负债'] ?? record['债务'] ?? 0);
        const accountNo = record.account_no || record.accountNo || record.account_number || record.card_no || record['账号'] || record['卡号'] || '';
        if (!owner || !bank || !Number.isFinite(balance)) return null;

        const identity = accountNo || `${owner}|${bank}|${source.worldbook}|${source.entry}`;
        return {
            account_id: `acct_${this._sanitizeName(owner)}_${this._hashString(identity)}`,
            owner_name: String(owner).trim(),
            bank_name: String(bank).trim(),
            bank_account_no: String(accountNo || '').trim(),
            initial_cash: Math.max(0, balance),
            initial_debt: Number.isFinite(debt) ? Math.max(0, debt) : 0,
            source_worldbook: source.worldbook,
            source_entry: source.entry,
        };
    }

    _extractBankAccountsFromEntry(entry, worldbookName) {
        const content = String(entry?.content || '');
        const source = { worldbook: worldbookName, entry: entry?.name || 'unknown' };
        const accounts = [];

        try {
            const records = this._parseLooseJsonRecords(content);
            records.forEach(record => {
                const account = this._normalizeBankAccountRecord(record, source);
                if (account) accounts.push(account);
            });
        } catch (error) {
            this.logger.warn(`解析开户行 JSON 失败，改用文本兜底: ${worldbookName}/${source.entry}`, error);
        }

        if (accounts.length === 0) {
            const fieldPattern = /["'“”‘’]?开户行["'“”‘’]?\s*[:：=]/;
            const matchedBlocks = content.match(new RegExp(`${fieldPattern.source}[\\s\\S]*?(?=\\n\\s*${fieldPattern.source}|\\n\\s*---|\\s*$)`, 'g'));
            const blocks = matchedBlocks && matchedBlocks.length > 1 ? matchedBlocks : [content];
            blocks.forEach(block => {
                const account = this._normalizeBankAccountRecord({
                    owner: this._extractLineField(block, ['户名', '账户名', '姓名', '角色', 'owner', 'name']),
                    bank: this._extractLineField(block, ['开户行', '开户银行', '银行', 'bank']),
                    balance: this._extractLineField(block, ['余额', '存款', '银行卡余额', '现金', 'balance', 'cash']),
                    debt: this._extractLineField(block, ['负债', '债务', 'debt']),
                    accountNo: this._extractLineField(block, ['账号', '卡号', 'account_no', 'account_number', 'card_no']),
                }, source);
                if (account) accounts.push(account);
            });
        }

        return accounts;
    }

    async _getBankAccountScanTargets() {
        const charBooks = await this.th.getCharWorldbookNames('current');
        const lorebookName = await this._getLorebookName();
        const controlName = this.config.multi_account.control_worldbook_name;
        const fxName = 'SillyView_fx';
        const names = [charBooks.primary, ...(charBooks.additional || [])].filter(Boolean);
        const targets = [];
        const skipped = [];

        for (const worldbookName of names) {
            const reason =
                worldbookName === lorebookName ? '主状态世界书' :
                worldbookName === controlName ? '多账户控制世界书' :
                worldbookName === fxName ? '行情上下文世界书' :
                worldbookName.startsWith(LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX) ? '历史多账户状态世界书' :
                '';

            if (reason) {
                skipped.push({ worldbookName, reason });
            } else {
                targets.push(worldbookName);
            }
        }

        return {
            primary: charBooks.primary || '',
            additional: [...(charBooks.additional || [])],
            targets,
            skipped,
        };
    }

    async scanBoundBankAccounts(options = {}) {
        const scanInfo = await this._getBankAccountScanTargets();
        const accountsById = new Map();
        const readErrors = [];
        const scanned = [];

        for (const worldbookName of scanInfo.targets) {
            let entries = [];
            try {
                entries = await this.th.getWorldbook(worldbookName);
            } catch (error) {
                this.logger.warn(`扫描开户行世界书失败: ${worldbookName}`, error);
                readErrors.push({ worldbookName, message: error?.message || String(error) });
                continue;
            }

            let matchedCount = 0;
            for (const entry of entries || []) {
                const accounts = this._extractBankAccountsFromEntry(entry, worldbookName);
                matchedCount += accounts.length;
                accounts.forEach(account => {
                    if (!accountsById.has(account.account_id)) accountsById.set(account.account_id, account);
                });
            }
            scanned.push({
                worldbookName,
                entryCount: (entries || []).length,
                matchedCount,
            });
        }

        const accounts = [...accountsById.values()];
        if (options.withDiagnostics) {
            return {
                accounts,
                diagnostics: {
                    ...scanInfo,
                    scanned,
                    readErrors,
                    accountCount: accounts.length,
                },
            };
        }

        return accounts;
    }

    async _ensureWorldbookExists(worldbookName, initialEntries = []) {
        if (String(worldbookName || '').startsWith(LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX)) {
            this.logger.warn(`已阻止创建旧版多账户个人世界书: ${worldbookName}`);
            return;
        }

        const allBooks = await this.th.getWorldbookNames();
        if (!allBooks.includes(worldbookName)) {
            await this.th.createOrReplaceWorldbook(worldbookName, initialEntries);
        }
    }

    async _ensureAdditionalWorldbook(worldbookName) {
        const charBooks = await this.th.getCharWorldbookNames('current');
        const additional = [...(charBooks.additional || [])];
        if (!additional.includes(worldbookName)) {
            additional.push(worldbookName);
            await this.th.rebindCharWorldbooks('current', {
                primary: charBooks.primary,
                additional,
            });
        }
    }

    _upsertWorldbookEntry(entries, name, content, enabled = true) {
        let entry = entries.find(item => item.name === name);
        if (!entry) {
            entry = { name, content: '', enabled };
            entries.push(entry);
        }
        entry.content = content;
        entry.enabled = enabled;
        return entry;
    }

    _getManagedAccountStateEntryName(accountId) {
        return `${this.config.multi_account.account_state_key}_${accountId}`;
    }

    _createManagedAccountState(account, stateEntryName) {
        const portfolio = this.dependencies.win._.cloneDeep(this.config.default_game_state.player_portfolio);
        portfolio.cash = account.initial_cash;
        portfolio.starting_cash = account.initial_cash;
        portfolio.debt = account.initial_debt || 0;
        portfolio.assets = {};
        portfolio.actions_this_turn = [];
        portfolio.asset_history = [{ time: 0, value: account.initial_cash - (account.initial_debt || 0) }];
        portfolio.transaction_log = [{ time: 0, description: `开户导入: ${account.bank_name}`, amount: account.initial_cash }];

        return {
            version: 1,
            account_id: account.account_id,
            owner_name: account.owner_name,
            bank_name: account.bank_name,
            bank_account_no: account.bank_account_no,
            source_worldbook: account.source_worldbook,
            source_entry: account.source_entry,
            worldbook_name: this.config.multi_account.control_worldbook_name,
            state_entry_name: stateEntryName,
            portfolio,
            created_at: Date.now(),
            updated_at: Date.now(),
        };
    }

    _parseManagedAccountStateFromEntries(entries, stateEntryName) {
        const stateEntry = (entries || []).find(entry => entry.name === stateEntryName);
        if (!stateEntry?.content) return null;
        const state = JSON.parse(stateEntry.content);
        state.state_entry_name = stateEntryName;
        state.worldbook_name = this.config.multi_account.control_worldbook_name;
        return state;
    }

    async _readLegacyManagedAccountState(account) {
        const controlName = this.config.multi_account.control_worldbook_name;
        if (
            !account?.worldbook_name ||
            account.worldbook_name === controlName ||
            !account.worldbook_name.startsWith(LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX)
        ) return null;

        try {
            const entries = await this.th.getWorldbook(account.worldbook_name);
            const stateEntryName = account.state_entry_name || this.config.multi_account.account_state_key;
            const stateEntry = entries.find(entry => entry.name === stateEntryName);
            if (!stateEntry?.content) return null;
            const state = JSON.parse(stateEntry.content);
            state.worldbook_name = controlName;
            state.state_entry_name = this._getManagedAccountStateEntryName(state.account_id || account.account_id);
            return state;
        } catch (error) {
            this.logger.warn(`读取旧账号世界书失败: ${account.worldbook_name}`, error);
            return null;
        }
    }

    async _migrateLegacyManagedAccountStates() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const indexKey = this.config.multi_account.account_index_key;
        const index = await this._readManagedAccountIndex();
        const migratedAccounts = [];
        let changed = false;

        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries([], []));

        for (const account of index) {
            if (!account?.worldbook_name?.startsWith(LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX)) {
                migratedAccounts.push(account);
                continue;
            }

            const state = await this._readLegacyManagedAccountState(account);
            const stateEntryName = account.state_entry_name || this._getManagedAccountStateEntryName(account.account_id);
            if (state) {
                state.worldbook_name = controlName;
                state.state_entry_name = stateEntryName;
                await this._writeManagedAccountState(state);
            }

            migratedAccounts.push({
                ...account,
                worldbook_name: controlName,
                state_entry_name: stateEntryName,
            });
            changed = true;
        }

        if (!changed) return false;

        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, indexKey, JSON.stringify({
                comment: 'SillyView 多账户索引。账号完整状态保存在本世界书内各自的 sv_account_state_* 词条中。',
                updated_at: Date.now(),
                accounts: migratedAccounts,
            }, null, 2), true);
            return entries;
        });
        return true;
    }

    async cleanupLegacyManagedAccountWorldbooks() {
        let allBooks = [];
        try {
            allBooks = await this.th.getWorldbookNames();
        } catch (error) {
            this.logger.warn('读取世界书列表失败，跳过旧多账户世界书清理。', error);
            return [];
        }

        const legacyNames = allBooks.filter(name => name.startsWith(LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX));
        if (legacyNames.length === 0) return [];

        await this._migrateLegacyManagedAccountStates();

        try {
            const charBooks = await this.th.getCharWorldbookNames('current');
            const additional = (charBooks.additional || []).filter(name => !legacyNames.includes(name));
            const primary = legacyNames.includes(charBooks.primary) ? null : charBooks.primary;
            if (primary !== charBooks.primary || additional.length !== (charBooks.additional || []).length) {
                await this.th.rebindCharWorldbooks('current', { primary, additional });
            }
        } catch (error) {
            this.logger.warn('解绑旧多账户个人世界书失败。', error);
        }

        const deleted = [];
        for (const worldbookName of legacyNames) {
            try {
                if (typeof this.th.deleteWorldbook === 'function') {
                    const ok = await this.th.deleteWorldbook(worldbookName);
                    if (ok) deleted.push(worldbookName);
                }
            } catch (error) {
                this.logger.warn(`删除旧多账户个人世界书失败: ${worldbookName}`, error);
            }
        }

        if (deleted.length > 0) {
            this.logger.success(`已清理旧多账户个人世界书: ${deleted.join(', ')}`);
        }
        return deleted;
    }

    async _ensureManagedAccountEntry(account) {
        const controlName = this.config.multi_account.control_worldbook_name;
        const stateEntryName = this._getManagedAccountStateEntryName(account.account_id);
        const initialState = this._createManagedAccountState(account, stateEntryName);
        const previousIndex = await this._readManagedAccountIndex();
        const previousAccount = previousIndex.find(item => item.account_id === account.account_id);
        const legacyState = await this._readLegacyManagedAccountState(previousAccount);

        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries([], []));
        await this.th.updateWorldbookWith(controlName, entries => {
            let stateEntry = entries.find(entry => entry.name === stateEntryName);
            if (!stateEntry) {
                const state = legacyState || initialState;
                state.worldbook_name = controlName;
                state.state_entry_name = stateEntryName;
                this._upsertWorldbookEntry(entries, stateEntryName, JSON.stringify(state, null, 2));
                return entries;
            }

            try {
                const state = JSON.parse(stateEntry.content);
                state.owner_name = state.owner_name || account.owner_name;
                state.bank_name = state.bank_name || account.bank_name;
                state.bank_account_no = state.bank_account_no || account.bank_account_no;
                state.source_worldbook = state.source_worldbook || account.source_worldbook;
                state.source_entry = state.source_entry || account.source_entry;
                state.worldbook_name = controlName;
                state.state_entry_name = stateEntryName;
                state.updated_at = Date.now();
                stateEntry.content = JSON.stringify(state, null, 2);
            } catch (error) {
                stateEntry.content = JSON.stringify(initialState, null, 2);
            }
            stateEntry.enabled = true;
            return entries;
        });

        return {
            account_id: account.account_id,
            owner_name: account.owner_name,
            bank_name: account.bank_name,
            worldbook_name: controlName,
            state_entry_name: stateEntryName,
            source_worldbook: account.source_worldbook,
            source_entry: account.source_entry,
        };
    }

    async _readManagedAccountIndex() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const indexKey = this.config.multi_account.account_index_key;
        try {
            const entries = await this.th.getWorldbook(controlName);
            const indexEntry = entries.find(entry => entry.name === indexKey);
            const parsed = indexEntry?.content ? JSON.parse(indexEntry.content) : {};
            return Array.isArray(parsed.accounts) ? parsed.accounts : [];
        } catch (error) {
            return [];
        }
    }

    async getManagedAccountStates() {
        const index = await this._readManagedAccountIndex();
        const states = [];
        const controlName = this.config.multi_account.control_worldbook_name;
        let controlEntries = [];

        try {
            controlEntries = await this.th.getWorldbook(controlName);
        } catch (error) {
            controlEntries = [];
        }

        for (const account of index) {
            try {
                const stateEntryName = account.state_entry_name || this._getManagedAccountStateEntryName(account.account_id);
                let state = this._parseManagedAccountStateFromEntries(controlEntries, stateEntryName);
                if (!state) state = await this._readLegacyManagedAccountState(account);
                if (!state) continue;
                state.account_id = state.account_id || account.account_id;
                state.state_entry_name = stateEntryName;
                state.worldbook_name = controlName;
                states.push(state);
            } catch (error) {
                this.logger.warn(`读取账号状态词条失败: ${account.state_entry_name || account.account_id}`, error);
            }
        }

        return states;
    }

    async _writeManagedAccountState(state) {
        const controlName = this.config.multi_account.control_worldbook_name;
        const stateEntryName = state.state_entry_name || this._getManagedAccountStateEntryName(state.account_id);
        state.updated_at = Date.now();
        state.worldbook_name = controlName;
        state.state_entry_name = stateEntryName;
        await this._ensureWorldbookExists(controlName, [{
            name: stateEntryName,
            enabled: true,
            content: JSON.stringify(state, null, 2),
        }]);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, stateEntryName, JSON.stringify(state, null, 2), true);
            return entries;
        });
    }

    _buildManagedTradeCommandGuide() {
        return [
            '【SillyView 多账户交易指令】',
            '账户编号必须使用 sv_accounts_query 中列出的 account_id。所有完整指令必须放在消息末尾唯一 <command>...</command> 块中。',
            '',
            '[Trade.Buy("account_id", "BTCUSD", 1000, 2, 72000, 66000)]：买入；无仓位开多，已有多头加仓，已有空头平空。',
            '[Trade.Sell("account_id", "ETHUSD", 500, 3, 3100, 3700)]：卖出；无仓位开空，已有空头加仓，已有多头平多。',
            '[Trade.OpenLong("account_id", "BTCUSD", 1000, 2, 72000, 66000)]',
            '[Trade.OpenShort("account_id", "BTCUSD", 1000, 2, 62000, 71000)]',
            '[Trade.AddLong("account_id", "BTCUSD", 500, 2, 72000, 66000)]',
            '[Trade.AddShort("account_id", "BTCUSD", 500, 2, 62000, 71000)]',
            '[Trade.CloseLong("account_id", "BTCUSD")]',
            '[Trade.CloseShort("account_id", "BTCUSD")]',
            '[Trade.SetRisk("account_id", "BTCUSD", 73000, 65000)]：调整止盈止损，填 0 清空对应价格。',
            '',
            'amount 是保证金/投入金额，leverage 为杠杆倍数，take_profit/stop_loss 可填 0 表示不设置。',
        ].join('\n');
    }

    _buildManagedAccountsQuery(states) {
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const lines = [
            '【SillyView 多账户实时账目查询】',
            `更新时间: t=${market.current_time_index || 0}, minute=${market.minute_time_index || 0}`,
            '',
        ];

        if (states.length === 0) {
            lines.push('暂无开户行账户。');
            return lines.join('\n');
        }

        for (const state of states) {
            const portfolio = state.portfolio || {};
            const stats = this.calculatePerformanceStats(portfolio);
            lines.push(`账户 ${state.account_id} | 户名: ${state.owner_name} | 开户行: ${state.bank_name}`);
            lines.push(`- 现金 ${Number(portfolio.cash || 0).toFixed(2)} | 债务 ${Number(portfolio.debt || 0).toFixed(2)} | 净值 ${stats.netWorth.toFixed(2)} | 收益率 ${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct.toFixed(2)}% | 已实现盈亏 ${stats.realizedPnl >= 0 ? '+' : ''}${stats.realizedPnl.toFixed(2)}`);

            const positions = [];
            for (const assetCode of Object.keys(portfolio.assets || {})) {
                const position = this.positionCalculator.calculate(assetCode, portfolio);
                if (!position.type || position.totalAmount <= 0) continue;
                const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = Number(assetData?.current_price || position.avgEntryPrice || 0);
                const pnl = position.type === 'short'
                    ? (position.avgEntryPrice - lastPrice) * position.totalShares
                    : (lastPrice - position.avgEntryPrice) * position.totalShares;
                const controls = portfolio.assets?.[assetCode]?.risk_controls || {};
                positions.push(`  * ${assetCode} ${position.type === 'short' ? '空头' : '多头'} ${position.leverage}x | 保证金 ${position.totalAmount.toFixed(2)} | 入场 ${position.avgEntryPrice.toFixed(4)} | 现价 ${lastPrice.toFixed(4)} | 浮动盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | 止盈 ${controls.take_profit || '未设'} | 止损 ${controls.stop_loss || '未设'}`);
            }
            lines.push(...(positions.length > 0 ? positions : ['  * 无持仓']));
            lines.push('');
        }

        return lines.join('\n');
    }

    _buildManagedRecentNews() {
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const news = (market.news_feed || []).slice(0, 10);
        if (news.length === 0) return '【SillyView 最近十条新闻】\n暂无市场新闻。';
        return ['【SillyView 最近十条新闻】', ...news.map(item => `- [t=${item.time_index}] ${item.asset_code || 'GLOBAL'}: ${item.headline}`)].join('\n');
    }

    _buildManagedScanReport(diagnostics = {}, accountEntries = null) {
        const accounts = accountEntries || [];
        const lines = [
            '【SillyView 多账户开户行扫描报告】',
            `更新时间: ${new Date().toISOString()}`,
            `角色卡主世界书: ${diagnostics.primary || '无'}`,
            `角色卡附加世界书: ${(diagnostics.additional || []).join(', ') || '无'}`,
            `参与扫描世界书: ${(diagnostics.targets || []).join(', ') || '无'}`,
            `识别账户数量: ${accounts.length}`,
            '',
        ];

        if ((diagnostics.skipped || []).length > 0) {
            lines.push('跳过世界书:');
            for (const item of diagnostics.skipped) {
                lines.push(`- ${item.worldbookName}: ${item.reason}`);
            }
            lines.push('');
        }

        if ((diagnostics.scanned || []).length > 0) {
            lines.push('扫描明细:');
            for (const item of diagnostics.scanned) {
                lines.push(`- ${item.worldbookName}: 词条 ${item.entryCount}, 命中开户行 ${item.matchedCount}`);
            }
            lines.push('');
        }

        if ((diagnostics.readErrors || []).length > 0) {
            lines.push('读取失败:');
            for (const item of diagnostics.readErrors) {
                lines.push(`- ${item.worldbookName}: ${item.message}`);
            }
            lines.push('');
        }

        if (accounts.length > 0) {
            lines.push('已写入角色专属账号状态词条:');
            for (const account of accounts) {
                lines.push(`- ${account.account_id} | ${account.owner_name} | ${account.bank_name} | ${account.state_entry_name} | 来源 ${account.source_worldbook}/${account.source_entry || '未命名词条'}`);
            }
        } else {
            lines.push('未识别到开户行账户。请确认开户行所在世界书仍绑定在当前角色卡主/附加世界书中，并且词条包含“开户行”和“户名/账户名/姓名”及“余额/存款/现金”等字段。');
        }

        return lines.join('\n');
    }

    _buildManagedControlEntries(states, accountEntries = null, scanDiagnostics = null) {
        const klineContext = this.getState(this.config.world_book_keys.kline_context) || this.config.default_game_state.kline_context;
        const entries = [];
        if (accountEntries) {
            entries.push({
                name: this.config.multi_account.account_index_key,
                enabled: true,
                content: JSON.stringify({
                    comment: 'SillyView 多账户索引。账号完整状态保存在本世界书内各自的 sv_account_state_* 词条中。',
                    updated_at: Date.now(),
                    accounts: accountEntries,
                }, null, 2),
            });
        }
        entries.push(
            {
                name: this.config.multi_account.command_entry_key,
                enabled: true,
                content: this._buildManagedTradeCommandGuide(),
            },
            {
                name: this.config.multi_account.account_query_key,
                enabled: true,
                content: this._buildManagedAccountsQuery(states),
            },
            {
                name: this.config.world_book_keys.kline_context,
                enabled: true,
                content: JSON.stringify(klineContext, null, 2),
            },
            {
                name: this.config.multi_account.recent_news_key,
                enabled: true,
                content: this._buildManagedRecentNews(),
            },
        );
        if (scanDiagnostics) {
            entries.push({
                name: this.config.multi_account.scan_report_key,
                enabled: true,
                content: this._buildManagedScanReport(scanDiagnostics, accountEntries || []),
            });
        }
        return entries;
    }

    async syncManagedAccountsWorldbook() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const states = await this.getManagedAccountStates();

        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries(states));
        await this._ensureAdditionalWorldbook(controlName);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, this.config.multi_account.command_entry_key, this._buildManagedTradeCommandGuide(), true);
            this._upsertWorldbookEntry(entries, this.config.multi_account.account_query_key, this._buildManagedAccountsQuery(states), true);
            const klineContext = this.getState(this.config.world_book_keys.kline_context) || this.config.default_game_state.kline_context;
            this._upsertWorldbookEntry(entries, this.config.world_book_keys.kline_context, JSON.stringify(klineContext, null, 2), true);
            this._upsertWorldbookEntry(entries, this.config.multi_account.recent_news_key, this._buildManagedRecentNews(), true);
            return entries;
        });
    }

    async autoDiscoverAndSyncManagedAccounts() {
        const scanResult = await this.scanBoundBankAccounts({ withDiagnostics: true });
        const accounts = scanResult.accounts || [];
        const controlName = this.config.multi_account.control_worldbook_name;
        const accountEntries = [];
        for (const account of accounts) {
            accountEntries.push(await this._ensureManagedAccountEntry(account));
        }

        const states = await this.getManagedAccountStates();
        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries(states, accountEntries, scanResult.diagnostics));
        await this._ensureAdditionalWorldbook(controlName);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, this.config.multi_account.account_index_key, JSON.stringify({
                comment: 'SillyView 多账户索引。账号完整状态保存在本世界书内各自的 sv_account_state_* 词条中。',
                updated_at: Date.now(),
                accounts: accountEntries,
            }, null, 2), true);
            this._upsertWorldbookEntry(entries, this.config.multi_account.scan_report_key, this._buildManagedScanReport(scanResult.diagnostics, accountEntries), true);
            return entries;
        });
        await this.syncManagedAccountsWorldbook();
        await this.cleanupLegacyManagedAccountWorldbooks();
        this.logger.success(`已同步 ${accountEntries.length} 个开户行账户到 ${controlName}。`);
        return accountEntries;
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

    _normalizeRiskControls(riskControls = null) {
        if (!riskControls || typeof riskControls !== 'object') return null;

        const normalizePrice = value => {
            const number = Number(value);
            return Number.isFinite(number) && number > 0 ? number : null;
        };

        return {
            take_profit: normalizePrice(riskControls.take_profit),
            stop_loss: normalizePrice(riskControls.stop_loss),
        };
    }

    _applyRiskControls(portfolio, assetCode, riskControls) {
        const normalized = this._normalizeRiskControls(riskControls);
        if (!normalized || (normalized.take_profit === null && normalized.stop_loss === null)) return '';

        if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
        const current = portfolio.assets[assetCode].risk_controls || {};
        portfolio.assets[assetCode].risk_controls = {
            take_profit: normalized.take_profit ?? current.take_profit ?? null,
            stop_loss: normalized.stop_loss ?? current.stop_loss ?? null,
        };

        const labels = [];
        if (normalized.take_profit !== null) labels.push(`止盈 ${normalized.take_profit.toFixed(4)}`);
        if (normalized.stop_loss !== null) labels.push(`止损 ${normalized.stop_loss.toFixed(4)}`);
        return labels.length > 0 ? ` (${labels.join(' / ')})` : '';
    }

    async updatePositionRiskControls(assetCode, riskControls) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const normalized = this._normalizeRiskControls(riskControls) || { take_profit: null, stop_loss: null };

        let updated = false;
        await this.updateState(portfolioKey, portfolio => {
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (!position.type || position.totalAmount <= 0) return portfolio;

            if (!portfolio.assets) portfolio.assets = {};
            if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };

            if (normalized.take_profit === null && normalized.stop_loss === null) {
                delete portfolio.assets[assetCode].risk_controls;
            } else {
                portfolio.assets[assetCode].risk_controls = normalized;
            }

            const labels = [];
            labels.push(normalized.take_profit === null ? '止盈 未设置' : `止盈 ${normalized.take_profit.toFixed(4)}`);
            labels.push(normalized.stop_loss === null ? '止损 未设置' : `止损 ${normalized.stop_loss.toFixed(4)}`);
            if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
            portfolio.actions_this_turn.push({
                id: Date.now(),
                text: `调整 ${assetCode} ${labels.join(' / ')}`,
                executedAt: null,
                intent: 'adjust_risk_controls',
                assetCode,
                riskControls: normalized,
            });

            updated = true;
            return portfolio;
        });

        return updated ? normalized : null;
    }

    async executeAndRecordTrade(intent, amount, assetCode, executionPrice = null, leverage = 1, riskControls = null) {
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
        this._ensureAssetDataShape(assetData);
        const lastMinuteCandle = assetData.kline_minute.slice(-1)[0];
        const lastCandle = lastMinuteCandle || assetData.kline_hourly.slice(-1)[0];
        const rawPrice = executionPrice !== null ? executionPrice : (assetData.current_price ?? lastCandle.close);
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
                const longRiskText = this._applyRiskControls(portfolio, assetCode, riskControls);
                
                actionText = (intent === 'open_long') 
                    ? `开多 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`
                    : `加仓多 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`;
                actionText += longRiskText;

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
                const shortRiskText = this._applyRiskControls(portfolio, assetCode, riskControls);
                
                actionText = (intent === 'open_short') 
                    ? `开空 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`
                    : `加仓空 ${isLeveragedTrade ? `(${leverage}x)` : ''}${assetCode}`;
                actionText += shortRiskText;

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
                delete portfolio.assets[assetCode].risk_controls;
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
                delete portfolio.assets[assetCode].risk_controls;
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

    async closePositionAtPrice(assetCode, closePrice, reason = 'risk_control') {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const market = this.getState(this.config.world_book_keys.global_market);
        const portfolio = this.getState(portfolioKey);
        if (!portfolio) return null;

        const position = this.positionCalculator.calculate(assetCode, portfolio);
        if (!position.type || position.totalAmount <= 0) return null;

        const tradeConfig = this._getTradeConfig(assetCode);
        const fee = position.positionValue * (tradeConfig.fee_rate ?? 0.001);
        const realizedPnl = position.type === 'long'
            ? (closePrice - position.avgEntryPrice) * position.totalShares
            : (position.avgEntryPrice - closePrice) * position.totalShares;
        const closeAmount = position.totalAmount + realizedPnl - fee;
        const label = reason === 'take_profit' ? '止盈' : '止损';

        await this.updateState(portfolioKey, p => {
            if (!p.assets) p.assets = {};
            if (!p.assets[assetCode]) p.assets[assetCode] = { trades: [] };
            p.cash = (p.cash || 0) + closeAmount;
            p.assets[assetCode].trades = [];
            delete p.assets[assetCode].risk_controls;
            if (!p.transaction_log) p.transaction_log = [];
            const time = market ? market.current_time_index : 0;
            p.transaction_log.unshift({ time, description: `${label}平仓 ${assetCode}`, amount: closeAmount });
            p.transaction_log.unshift({ time, description: `交易手续费`, amount: -fee });
            p.transaction_log.unshift({ time, description: `已实现盈亏 (${assetCode})`, amount: realizedPnl });
            if (p.transaction_log.length > 100) p.transaction_log.length = 100;
            return p;
        });

        this.dependencies.win.toastr.success(`${assetCode} ${label}触发，已按 ${closePrice.toFixed(4)} 平仓。`, label);
        return {
            triggered: true,
            triggerType: reason,
            price: closePrice,
            pnl: realizedPnl,
            fee,
        };
    }

    async triggerRiskControlsForCandle(assetCode, candle) {
        if (!candle) return null;

        const portfolio = this.getState(this.config.world_book_keys.player_portfolio);
        const position = this.positionCalculator.calculate(assetCode, portfolio);
        if (!position.type || position.totalAmount <= 0) return null;

        const assetPortfolio = portfolio?.assets?.[assetCode];
        const riskControls = assetPortfolio?.risk_controls;
        if (!riskControls) return null;

        const takeProfit = Number(riskControls.take_profit);
        const stopLoss = Number(riskControls.stop_loss);
        const open = Number(candle.open || candle.close || position.avgEntryPrice || 0);
        const high = Number(candle.high || open);
        const low = Number(candle.low || open);

        const hits = [];
        if (position.type === 'long') {
            if (Number.isFinite(takeProfit) && takeProfit > 0 && high >= takeProfit) hits.push({ type: 'take_profit', price: takeProfit, distance: Math.abs(takeProfit - open) });
            if (Number.isFinite(stopLoss) && stopLoss > 0 && low <= stopLoss) hits.push({ type: 'stop_loss', price: stopLoss, distance: Math.abs(stopLoss - open) });
        } else if (position.type === 'short') {
            if (Number.isFinite(takeProfit) && takeProfit > 0 && low <= takeProfit) hits.push({ type: 'take_profit', price: takeProfit, distance: Math.abs(takeProfit - open) });
            if (Number.isFinite(stopLoss) && stopLoss > 0 && high >= stopLoss) hits.push({ type: 'stop_loss', price: stopLoss, distance: Math.abs(stopLoss - open) });
        }

        if (hits.length === 0) return null;
        if (hits.length > 1) {
            const candleDirectionUp = Number(candle.close || open) >= open;
            const preferredType = candleDirectionUp ? 'take_profit' : 'stop_loss';
            const preferredHit = hits.find(hit => hit.type === preferredType);
            if (preferredHit) {
                return await this.closePositionAtPrice(assetCode, preferredHit.price, preferredHit.type);
            }
        }

        hits.sort((a, b) => a.distance - b.distance);
        return await this.closePositionAtPrice(assetCode, hits[0].price, hits[0].type);
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

    async accrueFundingFees(hours = 1) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this.getState(portfolioKey);
        if (!portfolio?.assets) return 0;

        const normalizedHours = Math.max(1, Math.floor(Number(hours) || 1));
        const fundingItems = [];
        for (const assetCode of Object.keys(portfolio.assets)) {
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (!position.isLeveraged || !position.type || position.positionValue <= 0) continue;

            const rate = Number(this._getTradeConfig(assetCode).funding_rate_hourly || 0);
            if (!Number.isFinite(rate) || rate === 0) continue;

            const signedCost = position.positionValue * rate * normalizedHours * (position.type === 'long' ? 1 : -1);
            if (Math.abs(signedCost) < 0.01) continue;
            fundingItems.push({ assetCode, amount: signedCost });
        }

        if (fundingItems.length === 0) return 0;

        const totalCost = fundingItems.reduce((sum, item) => sum + item.amount, 0);
        const market = this.getState(this.config.world_book_keys.global_market);
        const time = market ? market.current_time_index : 0;

        await this.updateState(portfolioKey, p => {
            if (!p.transaction_log) p.transaction_log = [];
            p.cash = (p.cash || 0) - totalCost;
            fundingItems.forEach(item => {
                const label = item.amount >= 0 ? '资金费率支出' : '资金费率收入';
                p.transaction_log.unshift({
                    time,
                    description: `${label} (${item.assetCode})`,
                    amount: -item.amount,
                });
            });
            if (p.transaction_log.length > 100) p.transaction_log.length = 100;
            return p;
        });

        this.logger.log(`结算 ${normalizedHours} 小时资金费率: ${(-totalCost).toFixed(2)}。`);
        return totalCost;
    }

    _recordAccountTransaction(portfolio, description, amount) {
        const market = this.getState(this.config.world_book_keys.global_market);
        const time = market ? market.current_time_index : 0;
        if (!portfolio.transaction_log) portfolio.transaction_log = [];
        portfolio.transaction_log.unshift({ time, description, amount });
        if (portfolio.transaction_log.length > 100) portfolio.transaction_log.length = 100;
    }

    _recordAccountHistory(portfolio) {
        if (!portfolio) return;
        const value = this._calculatePortfolioMarkedValue(portfolio);
        const market = this.getState(this.config.world_book_keys.global_market);
        const time = market ? market.current_time_index : Date.now();
        if (!portfolio.asset_history) portfolio.asset_history = [];
        const last = portfolio.asset_history[portfolio.asset_history.length - 1];
        if (last && last.time === time) {
            last.value = value;
        } else {
            portfolio.asset_history.push({ time, value });
        }
        if (portfolio.asset_history.length > 365) portfolio.asset_history = portfolio.asset_history.slice(-365);
    }

    async _getManagedAccountStateById(accountId) {
        const states = await this.getManagedAccountStates();
        return states.find(state => state.account_id === accountId) || null;
    }

    async getManagedAccountOpenAssetCodes() {
        const states = await this.getManagedAccountStates();
        const assetCodes = new Set();
        for (const state of states) {
            const assets = state.portfolio?.assets || {};
            for (const assetCode of Object.keys(assets)) {
                if ((assets[assetCode]?.trades || []).length > 0) assetCodes.add(assetCode);
            }
        }
        return [...assetCodes];
    }

    _getAccountIntentFromTradeCommand(commandType, position) {
        const type = String(commandType || '').toLowerCase();
        const explicit = {
            openlong: 'open_long',
            addlong: 'add_long',
            closelong: 'close_long',
            openshort: 'open_short',
            addshort: 'add_short',
            closeshort: 'close_short',
        }[type];
        if (explicit) return explicit;

        if (type === 'buy') {
            if (position.type === 'short') return 'close_short';
            if (position.type === 'long') return 'add_long';
            return 'open_long';
        }
        if (type === 'sell') {
            if (position.type === 'long') return 'close_long';
            if (position.type === 'short') return 'add_short';
            return 'open_short';
        }
        return null;
    }

    async updateManagedAccountRiskControls(accountId, assetCode, riskControls) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state) return false;
        const portfolio = state.portfolio || {};
        const position = this.positionCalculator.calculate(assetCode, portfolio);
        if (!position.type || position.totalAmount <= 0) return false;

        const normalized = this._normalizeRiskControls(riskControls) || { take_profit: null, stop_loss: null };
        if (!portfolio.assets) portfolio.assets = {};
        if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
        if (normalized.take_profit === null && normalized.stop_loss === null) {
            delete portfolio.assets[assetCode].risk_controls;
        } else {
            portfolio.assets[assetCode].risk_controls = normalized;
        }

        if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
        portfolio.actions_this_turn.push({
            id: Date.now(),
            text: `AI调整 ${assetCode} 止盈 ${normalized.take_profit || '未设置'} / 止损 ${normalized.stop_loss || '未设置'}`,
            executedAt: null,
            intent: 'adjust_risk_controls',
            assetCode,
            riskControls: normalized,
        });

        state.portfolio = portfolio;
        this._recordAccountHistory(portfolio);
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async executeManagedAccountTrade(accountId, commandType, assetCode, amount = 0, leverage = 1, riskControls = null) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state || !this.config.asset_definitions[assetCode]) return false;

        const portfolio = state.portfolio || {};
        if (!portfolio.assets) portfolio.assets = {};
        portfolio.cash = Number(portfolio.cash || 0);

        const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const lastCandle = assetData?.kline_minute?.slice(-1)[0] || assetData?.kline_hourly?.slice(-1)[0];
        const rawPrice = Number(assetData?.current_price || lastCandle?.close || 0);
        if (!rawPrice) return false;

        const position = this.positionCalculator.calculate(assetCode, portfolio);
        const intent = this._getAccountIntentFromTradeCommand(commandType, position);
        if (!intent) return false;

        const maxLeverage = this.config.asset_definitions[assetCode]?.max_leverage || 1;
        const normalizedLeverage = Math.min(Math.max(1, Math.floor(Number(leverage) || 1)), maxLeverage);
        const normalizedAmount = Math.max(0, Number(amount) || 0);
        const tradeConfig = this._getTradeConfig(assetCode);
        const price = this._calculateExecutionPrice(assetCode, intent, rawPrice);
        const totalPositionValue = intent.startsWith('close') ? position.positionValue : normalizedAmount * normalizedLeverage;
        const fee = totalPositionValue * (tradeConfig.fee_rate ?? 0.001);
        let actionText = '';

        switch (intent) {
            case 'open_long':
                if (position.type) return false;
            case 'add_long':
                if (position.type === 'short' || normalizedAmount <= 0 || portfolio.cash < normalizedAmount + fee) return false;
                portfolio.cash -= normalizedAmount + fee;
                if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
                portfolio.assets[assetCode].trades.push({ time: lastCandle?.time || 0, price, amount: normalizedAmount, type: 'long', leverage: normalizedLeverage });
                actionText = `${state.owner_name} ${intent === 'open_long' ? '开多' : '加仓多'} ${assetCode} ${normalizedLeverage}x`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls);
                this._recordAccountTransaction(portfolio, actionText, -normalizedAmount);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                break;

            case 'open_short':
                if (position.type) return false;
            case 'add_short':
                if (position.type === 'long' || normalizedAmount <= 0 || portfolio.cash < normalizedAmount + fee) return false;
                portfolio.cash -= normalizedAmount + fee;
                if (!portfolio.assets[assetCode]) portfolio.assets[assetCode] = { trades: [] };
                portfolio.assets[assetCode].trades.push({ time: lastCandle?.time || 0, price, amount: normalizedAmount, type: 'short', leverage: normalizedLeverage });
                actionText = `${state.owner_name} ${intent === 'open_short' ? '开空' : '加仓空'} ${assetCode} ${normalizedLeverage}x`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls);
                this._recordAccountTransaction(portfolio, actionText, -normalizedAmount);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                break;

            case 'close_long': {
                if (position.type !== 'long') return false;
                const pnl = (price - position.avgEntryPrice) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl - fee;
                this._recordAccountTransaction(portfolio, `平多仓 ${assetCode}`, position.totalAmount + pnl);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                this._recordAccountTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl);
                portfolio.assets[assetCode].trades = [];
                delete portfolio.assets[assetCode].risk_controls;
                actionText = `${state.owner_name} 平多 ${assetCode}`;
                break;
            }

            case 'close_short': {
                if (position.type !== 'short') return false;
                const pnl = (position.avgEntryPrice - price) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl - fee;
                this._recordAccountTransaction(portfolio, `平空仓 ${assetCode}`, position.totalAmount + pnl);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                this._recordAccountTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl);
                portfolio.assets[assetCode].trades = [];
                delete portfolio.assets[assetCode].risk_controls;
                actionText = `${state.owner_name} 平空 ${assetCode}`;
                break;
            }

            default:
                return false;
        }

        if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
        portfolio.actions_this_turn.push({ id: Date.now(), text: actionText, executedAt: price, intent, amount: normalizedAmount, leverage: normalizedLeverage, assetCode });
        state.portfolio = portfolio;
        this._recordAccountHistory(portfolio);
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async processManagedAccountTradeCommand(command) {
        if (command.module !== 'Trade') return false;
        const [accountId, assetCode] = command.args;
        if (typeof accountId !== 'string' || typeof assetCode !== 'string') return false;

        if (command.type === 'SetRisk') {
            const [, , takeProfit = 0, stopLoss = 0] = command.args;
            return await this.updateManagedAccountRiskControls(accountId, assetCode, {
                take_profit: Number(takeProfit) || null,
                stop_loss: Number(stopLoss) || null,
            });
        }

        const [, , amount = 0, leverage = 1, takeProfit = 0, stopLoss = 0] = command.args;
        return await this.executeManagedAccountTrade(accountId, command.type, assetCode, Number(amount) || 0, Number(leverage) || 1, {
            take_profit: Number(takeProfit) || null,
            stop_loss: Number(stopLoss) || null,
        });
    }

    async closeManagedAccountPositionAtPrice(state, assetCode, closePrice, reason = 'risk_control') {
        const portfolio = state.portfolio || {};
        const position = this.positionCalculator.calculate(assetCode, portfolio);
        if (!position.type || position.totalAmount <= 0 || !portfolio.assets?.[assetCode]) return false;

        const fee = position.positionValue * (this._getTradeConfig(assetCode).fee_rate ?? 0.001);
        const pnl = position.type === 'long'
            ? (closePrice - position.avgEntryPrice) * position.totalShares
            : (position.avgEntryPrice - closePrice) * position.totalShares;
        portfolio.cash = (portfolio.cash || 0) + position.totalAmount + pnl - fee;
        portfolio.assets[assetCode].trades = [];
        delete portfolio.assets[assetCode].risk_controls;
        const label = reason === 'take_profit' ? '止盈' : (reason === 'liquidation' ? '爆仓强平' : '止损');
        this._recordAccountTransaction(portfolio, `${label}平仓 ${assetCode}`, position.totalAmount + pnl);
        this._recordAccountTransaction(portfolio, '交易手续费', -fee);
        this._recordAccountTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl);
        this._recordAccountHistory(portfolio);
        state.portfolio = portfolio;
        await this._writeManagedAccountState(state);
        return true;
    }

    async processManagedAccountRiskForCandle(assetCode, candle) {
        if (!candle) return false;
        const states = await this.getManagedAccountStates();
        let changed = false;

        for (const state of states) {
            const portfolio = state.portfolio || {};
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (!position.type || position.totalAmount <= 0) continue;

            if (position.isLeveraged && position.liquidationPrice > 0) {
                const hit = position.type === 'long'
                    ? Number(candle.low || candle.close) <= position.liquidationPrice
                    : Number(candle.high || candle.close) >= position.liquidationPrice;
                if (hit) {
                    changed = await this.closeManagedAccountPositionAtPrice(state, assetCode, position.liquidationPrice, 'liquidation') || changed;
                    continue;
                }
            }

            const controls = portfolio.assets?.[assetCode]?.risk_controls;
            if (!controls) continue;
            const takeProfit = Number(controls.take_profit);
            const stopLoss = Number(controls.stop_loss);
            const open = Number(candle.open || candle.close || position.avgEntryPrice || 0);
            const high = Number(candle.high || open);
            const low = Number(candle.low || open);
            const hits = [];

            if (position.type === 'long') {
                if (Number.isFinite(takeProfit) && takeProfit > 0 && high >= takeProfit) hits.push({ type: 'take_profit', price: takeProfit, distance: Math.abs(takeProfit - open) });
                if (Number.isFinite(stopLoss) && stopLoss > 0 && low <= stopLoss) hits.push({ type: 'stop_loss', price: stopLoss, distance: Math.abs(stopLoss - open) });
            } else {
                if (Number.isFinite(takeProfit) && takeProfit > 0 && low <= takeProfit) hits.push({ type: 'take_profit', price: takeProfit, distance: Math.abs(takeProfit - open) });
                if (Number.isFinite(stopLoss) && stopLoss > 0 && high >= stopLoss) hits.push({ type: 'stop_loss', price: stopLoss, distance: Math.abs(stopLoss - open) });
            }

            if (hits.length > 0) {
                hits.sort((a, b) => a.distance - b.distance);
                changed = await this.closeManagedAccountPositionAtPrice(state, assetCode, hits[0].price, hits[0].type) || changed;
            }
        }

        if (changed) await this.syncManagedAccountsWorldbook();
        return changed;
    }

    async accrueManagedAccountFundingFees(hours = 1) {
        const states = await this.getManagedAccountStates();
        if (states.length === 0) return 0;
        const normalizedHours = Math.max(1, Math.floor(Number(hours) || 1));
        let changed = false;
        let totalCost = 0;

        for (const state of states) {
            const portfolio = state.portfolio || {};
            if (!portfolio.assets) continue;
            let accountChanged = false;
            for (const assetCode of Object.keys(portfolio.assets)) {
                const position = this.positionCalculator.calculate(assetCode, portfolio);
                if (!position.isLeveraged || !position.type || position.positionValue <= 0) continue;
                const rate = Number(this._getTradeConfig(assetCode).funding_rate_hourly || 0);
                if (!Number.isFinite(rate) || rate === 0) continue;
                const signedCost = position.positionValue * rate * normalizedHours * (position.type === 'long' ? 1 : -1);
                if (Math.abs(signedCost) < 0.01) continue;
                portfolio.cash = (portfolio.cash || 0) - signedCost;
                this._recordAccountTransaction(portfolio, `${signedCost >= 0 ? '资金费率支出' : '资金费率收入'} (${assetCode})`, -signedCost);
                totalCost += signedCost;
                accountChanged = true;
                changed = true;
            }
            if (accountChanged) {
                state.portfolio = portfolio;
                this._recordAccountHistory(portfolio);
                await this._writeManagedAccountState(state);
            }
        }

        if (changed) await this.syncManagedAccountsWorldbook();
        return totalCost;
    }
    
    async updateAssetCandles(assetCode, newCandles, minuteCandles = []) {
        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        await this.updateState(assetKey, assetData => {
            if (!assetData) return null;
            this._ensureAssetDataShape(assetData);

            if (Array.isArray(newCandles) && newCandles.length > 0) {
                const lastHourlyTime = assetData.kline_hourly[assetData.kline_hourly.length - 1]?.time ?? -Infinity;
                assetData.kline_hourly.push(...newCandles.filter(c => c.time > lastHourlyTime));
            }

            if (Array.isArray(minuteCandles) && minuteCandles.length > 0) {
                const lastMinuteTime = assetData.kline_minute[assetData.kline_minute.length - 1]?.time ?? -Infinity;
                assetData.kline_minute.push(...minuteCandles.filter(c => c.time > lastMinuteTime));
            }

            const lastMinute = assetData.kline_minute[assetData.kline_minute.length - 1];
            const lastHourly = assetData.kline_hourly[assetData.kline_hourly.length - 1];
            assetData.current_price = lastMinute?.close ?? lastHourly?.close ?? assetData.current_price;
            this._trimCandles(assetData);
            return assetData;
        });
    }

    async appendMinuteCandles(assetCode, minuteCandles) {
        if (!Array.isArray(minuteCandles) || minuteCandles.length === 0) return;

        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        await this.updateState(assetKey, assetData => {
            if (!assetData) return null;
            this._ensureAssetDataShape(assetData);

            const lastMinuteTime = assetData.kline_minute[assetData.kline_minute.length - 1]?.time ?? -Infinity;
            assetData.kline_minute.push(...minuteCandles.filter(c => c.time > lastMinuteTime));
            assetData.current_price = assetData.kline_minute[assetData.kline_minute.length - 1]?.close ?? assetData.current_price;
            this._trimCandles(assetData);
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

    calculatePerformanceStats(portfolio = null) {
        const resolvedPortfolio = portfolio || this.getState(this.config.world_book_keys.player_portfolio);
        if (!resolvedPortfolio) {
            return {
                netWorth: 0,
                startingCash: 0,
                returnPct: 0,
                maxDrawdownPct: 0,
                realizedPnl: 0,
                winRatePct: 0,
                winningTrades: 0,
                losingTrades: 0,
                tradeCount: 0,
            };
        }

        const netWorth = this._calculatePortfolioMarkedValue(resolvedPortfolio);
        const history = Array.isArray(resolvedPortfolio.asset_history) ? resolvedPortfolio.asset_history : [];
        const startingCash = Number(
            resolvedPortfolio.starting_cash ??
            history[0]?.value ??
            this.config.default_game_state.player_portfolio.starting_cash ??
            0
        );
        const returnPct = startingCash > 0 ? ((netWorth / startingCash) - 1) * 100 : 0;

        let peak = startingCash > 0 ? startingCash : (history[0]?.value || netWorth);
        let maxDrawdownPct = 0;
        for (const point of history) {
            const value = Number(point.value || 0);
            if (value > peak) peak = value;
            if (peak > 0) {
                maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - value) / peak) * 100);
            }
        }
        if (peak > 0) {
            maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - netWorth) / peak) * 100);
        }

        const realizedPnls = (resolvedPortfolio.transaction_log || [])
            .filter(log => String(log.description || '').includes('已实现盈亏'))
            .map(log => Number(log.amount || 0));
        const realizedPnl = realizedPnls.reduce((sum, value) => sum + value, 0);
        const winningTrades = realizedPnls.filter(value => value > 0).length;
        const losingTrades = realizedPnls.filter(value => value < 0).length;
        const tradeCount = winningTrades + losingTrades;
        const winRatePct = tradeCount > 0 ? (winningTrades / tradeCount) * 100 : 0;

        return {
            netWorth,
            startingCash,
            returnPct,
            maxDrawdownPct,
            realizedPnl,
            winRatePct,
            winningTrades,
            losingTrades,
            tradeCount,
        };
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
