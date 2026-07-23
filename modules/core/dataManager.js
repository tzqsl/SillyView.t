/**
 * SillyView - Data Manager (v6.3 - Robustness Hotfix)
 * Manages all interactions with SillyTavern's World Book, state caching, and snapshots.
 */
'use strict';

import { Logger } from '../logger.js';
import { SillyViewConfig } from '../config.js';

const LEGACY_MANAGED_ACCOUNT_WORLDBOOK_PREFIX = 'SillyView_account_';
const DEPRECATED_MANAGED_ACCOUNT_ENTRIES = new Set(['sv_accounts_query', 'sv_accounts_scan_report']);

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
        this.activeManagedObservationSession = null;
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

    _buildInitialAssetData(assetDef) {
        return {
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
                volume: 0,
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
    }

    _ensurePortfolioAssetBuckets(portfolio, assetCode) {
        if (!portfolio.assets || typeof portfolio.assets !== 'object') portfolio.assets = {};
        const asset = portfolio.assets[assetCode] && typeof portfolio.assets[assetCode] === 'object'
            ? portfolio.assets[assetCode]
            : {};
        const legacyTrades = Array.isArray(asset.trades) ? asset.trades : [];
        const hasLegacyPosition = legacyTrades.length > 0;
        const legacyIsLeveraged = legacyTrades.some(trade => Number(trade.leverage || 1) > 1 || trade.type === 'short');

        if (!asset.spot || typeof asset.spot !== 'object') asset.spot = { trades: [] };
        if (!asset.leveraged || typeof asset.leveraged !== 'object') asset.leveraged = { trades: [] };
        if (!Array.isArray(asset.spot.trades)) asset.spot.trades = [];
        if (!Array.isArray(asset.leveraged.trades)) asset.leveraged.trades = [];

        if (hasLegacyPosition) {
            const bucket = legacyIsLeveraged ? asset.leveraged : asset.spot;
            bucket.trades.push(...legacyTrades);
            if (asset.risk_controls && !bucket.risk_controls) bucket.risk_controls = asset.risk_controls;
        }
        delete asset.trades;
        delete asset.risk_controls;
        portfolio.assets[assetCode] = asset;
        return asset;
    }

    _migratePortfolioPositionBuckets(portfolio) {
        if (!portfolio?.assets || typeof portfolio.assets !== 'object') return false;
        let changed = false;
        for (const assetCode of Object.keys(portfolio.assets)) {
            const asset = portfolio.assets[assetCode] || {};
            if (Array.isArray(asset.trades) || !asset.spot || !asset.leveraged || asset.risk_controls
                || !Array.isArray(asset.spot?.trades) || !Array.isArray(asset.leveraged?.trades)) changed = true;
            this._ensurePortfolioAssetBuckets(portfolio, assetCode);
        }
        return changed;
    }

    _ensurePendingOrderShape(portfolio) {
        if (!portfolio || typeof portfolio !== 'object') return false;
        let changed = false;
        if (!Array.isArray(portfolio.pending_orders)) {
            portfolio.pending_orders = [];
            changed = true;
        }
        if (!Array.isArray(portfolio.order_history)) {
            portfolio.order_history = [];
            changed = true;
        }
        return changed;
    }

    _settleUnsupportedPortfolioAssets(portfolio, supportedAssets, legacyPrices, timeIndex = 0) {
        if (!portfolio?.assets || typeof portfolio.assets !== 'object') return false;

        let changed = false;
        if (!Array.isArray(portfolio.transaction_log)) portfolio.transaction_log = [];
        const unsupportedAssetCodes = Object.keys(portfolio.assets).filter(assetCode => !supportedAssets.has(assetCode));
        if (unsupportedAssetCodes.length > 0) {
            portfolio.transaction_log = portfolio.transaction_log.filter(log =>
                !unsupportedAssetCodes.some(assetCode => String(log?.description || '').includes(assetCode))
            );
        }
        for (const assetCode of unsupportedAssetCodes) {

            const positions = this.positionCalculator.calculateAll(assetCode, portfolio);
            const openPositions = Object.values(positions).filter(position => position.type && position.totalAmount > 0);
            if (openPositions.length > 0) {
                const marketPrice = Number(legacyPrices.get(assetCode)) || openPositions[0].avgEntryPrice;
                let realizedPnl = 0;
                let returnedCash = 0;
                for (const position of openPositions) {
                    const pnl = position.type === 'short'
                        ? (position.avgEntryPrice - marketPrice) * position.totalShares
                        : (marketPrice - position.avgEntryPrice) * position.totalShares;
                    const boundedPnl = Math.max(-position.totalAmount, pnl);
                    realizedPnl += boundedPnl;
                    returnedCash += position.totalAmount + boundedPnl;
                }
                portfolio.cash = Number(portfolio.cash || 0) + returnedCash;
                portfolio.transaction_log.unshift({
                    time: timeIndex,
                    description: '旧品种资产池升级结算',
                    amount: returnedCash,
                });
                portfolio.transaction_log.unshift({
                    time: timeIndex,
                    description: '资产池升级已实现盈亏',
                    amount: realizedPnl,
                });
            }
            delete portfolio.assets[assetCode];
            changed = true;
        }

        if (Array.isArray(portfolio.actions_this_turn)) {
            portfolio.actions_this_turn = portfolio.actions_this_turn.filter(action =>
                !action?.assetCode || supportedAssets.has(action.assetCode)
            );
        }
        if (portfolio.transaction_log.length > 100) portfolio.transaction_log.length = 100;
        return changed;
    }

    _normalizeNewsItem(item, fallbackTime = 0, fallbackDurationHours = 6) {
        const headline = String(item?.headline || '').replace(/\s+/g, ' ').trim();
        if (!headline) return null;
        const createdAt = Number(item.created_at ?? item.time_index ?? fallbackTime) || 0;
        const durationHours = Math.min(168, Math.max(1, Math.floor(Number(item.duration_hours || fallbackDurationHours) || fallbackDurationHours)));
        const expiresAt = Number(item.expires_at) || createdAt + durationHours;
        const assetCode = this.config.asset_definitions[item.asset_code] ? item.asset_code : 'GLOBAL';
        return {
            id: item.id || `news_${createdAt}_${this._hashString(`${assetCode}|${headline}`)}`,
            headline,
            asset_code: assetCode,
            created_at: createdAt,
            expires_at: expiresAt,
            duration_hours: durationHours,
        };
    }

    _mergeNewsItems(...lists) {
        const byId = new Map();
        for (const item of lists.flat()) {
            if (!item?.id) continue;
            const duplicate = [...byId.values()].find(existing =>
                Number(existing.created_at || 0) === Number(item.created_at || 0) &&
                existing.asset_code === item.asset_code &&
                existing.headline === item.headline
            );
            if (!duplicate) byId.set(item.id, item);
        }
        return [...byId.values()].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    }

    async _migrateAssetUniverse(lorebookName) {
        const keys = this.config.world_book_keys;
        const configuredAssets = Object.keys(this.config.asset_definitions);
        const supportedAssets = new Set(configuredAssets);
        const legacyPrices = new Map();

        for (const [key, value] of this._stateCache.entries()) {
            if (!key.startsWith(keys.asset_prefix)) continue;
            const assetCode = key.slice(keys.asset_prefix.length);
            const lastCandle = value?.kline_minute?.slice(-1)[0] || value?.kline_hourly?.slice(-1)[0];
            legacyPrices.set(assetCode, Number(value?.current_price || lastCandle?.close || 0));
        }

        const market = this._stateCache.get(keys.global_market) || {};
        delete market.remaining_candles;
        const timeIndex = Number(market.current_time_index || 0);
        const portfolio = this._stateCache.get(keys.player_portfolio) || {};
        const bucketsMigrated = this._migratePortfolioPositionBuckets(portfolio);
        let ordersMigrated = this._ensurePendingOrderShape(portfolio);
        const originalPendingCount = portfolio.pending_orders.length;
        portfolio.pending_orders = portfolio.pending_orders.filter(order => supportedAssets.has(order?.asset_code));
        if (portfolio.pending_orders.length !== originalPendingCount) ordersMigrated = true;
        const portfolioChanged = this._settleUnsupportedPortfolioAssets(portfolio, supportedAssets, legacyPrices, timeIndex)
            || bucketsMigrated
            || ordersMigrated;
        if (portfolioChanged) this._stateCache.set(keys.player_portfolio, portfolio);

        const configState = {
            ...this.config.default_game_state.config,
            ...(this._stateCache.get(keys.config) || {}),
            version: this.config.default_game_state.config.version,
            available_assets: configuredAssets,
        };
        this._stateCache.set(keys.config, configState);

        if (market.macro_state && Object.prototype.hasOwnProperty.call(market.macro_state, 'crypto_sentiment')) {
            delete market.macro_state.crypto_sentiment;
        }
        const legacyNews = (Array.isArray(market.news_feed) ? market.news_feed : [])
            .filter(item => !item?.asset_code || item.asset_code === 'GLOBAL' || supportedAssets.has(item.asset_code))
            .map(item => this._normalizeNewsItem(item, timeIndex))
            .filter(Boolean);
        delete market.news_feed;
        this._stateCache.set(keys.global_market, market);

        const archiveState = {
            ...this.config.default_game_state.news_archive,
            ...(this._stateCache.get(keys.news_archive) || {}),
        };
        archiveState.items = this._mergeNewsItems(archiveState.items || [], legacyNews);
        archiveState.updated_at = timeIndex;
        this._stateCache.set(keys.news_archive, archiveState);

        const activeNewsState = {
            ...this.config.default_game_state.active_market_news,
            ...(this._stateCache.get(keys.active_market_news) || {}),
        };
        activeNewsState.items = this._mergeNewsItems(activeNewsState.items || [], legacyNews)
            .filter(item => Number(item.expires_at || 0) > timeIndex);
        activeNewsState.updated_at = timeIndex;
        this._stateCache.set(keys.active_market_news, activeNewsState);

        const targetState = this._stateCache.get(keys.market_targets);
        if (targetState?.targets) {
            targetState.targets = Object.fromEntries(
                Object.entries(targetState.targets).filter(([assetCode]) => supportedAssets.has(assetCode))
            );
            this._stateCache.set(keys.market_targets, targetState);
        }

        const removedAssetKeys = [];
        for (const key of [...this._stateCache.keys()]) {
            if (!key.startsWith(keys.asset_prefix)) continue;
            const assetCode = key.slice(keys.asset_prefix.length);
            if (!supportedAssets.has(assetCode)) {
                this._stateCache.delete(key);
                removedAssetKeys.push(key);
            }
        }
        for (const assetCode of configuredAssets) {
            const assetKey = `${keys.asset_prefix}${assetCode}`;
            if (!this._stateCache.has(assetKey)) {
                this._stateCache.set(assetKey, this._buildInitialAssetData(this.config.asset_definitions[assetCode]));
            }
        }

        await this.th.updateWorldbookWith(lorebookName, entries => {
            const migratedEntries = entries.filter(entry => {
                if (!entry.name?.startsWith(keys.asset_prefix)) return true;
                return supportedAssets.has(entry.name.slice(keys.asset_prefix.length));
            });

            const upsertState = (name, value, enabled) => {
                let entry = migratedEntries.find(item => item.name === name);
                if (!entry) {
                    entry = { name, content: '', enabled };
                    migratedEntries.push(entry);
                }
                entry.content = JSON.stringify(value, null, 2);
                entry.enabled = enabled;
            };

            upsertState(keys.config, configState, false);
            upsertState(keys.global_market, market, false);
            upsertState(keys.player_portfolio, portfolio, false);
            const aiContext = this._stateCache.get(keys.ai_context);
            if (aiContext) upsertState(keys.ai_context, aiContext, false);
            if (targetState) upsertState(keys.market_targets, targetState, false);
            upsertState(keys.news_archive, archiveState, false);
            upsertState(keys.active_market_news, activeNewsState, false);
            for (const assetCode of configuredAssets) {
                upsertState(`${keys.asset_prefix}${assetCode}`, this._stateCache.get(`${keys.asset_prefix}${assetCode}`), false);
            }
            return migratedEntries;
        });

        try {
            const allBooks = await this.th.getWorldbookNames();
            const controlName = this.config.multi_account.control_worldbook_name;
            if (allBooks.includes(controlName)) {
                await this.th.updateWorldbookWith(controlName, entries => {
                    for (const entry of entries) {
                        if (!entry.name?.startsWith(`${this.config.multi_account.account_state_key}_`)) continue;
                        entry.enabled = false;
                        try {
                            const state = JSON.parse(entry.content);
                            if (this._settleUnsupportedPortfolioAssets(state.portfolio, supportedAssets, legacyPrices, timeIndex)) {
                                state.updated_at = Date.now();
                                entry.content = JSON.stringify(state, null, 2);
                            }
                        } catch (error) {
                            this.logger.warn(`迁移多账户外汇资产失败: ${entry.name}`, error);
                        }
                    }
                    return entries;
                });
            }
        } catch (error) {
            this.logger.warn('迁移多账户资产池失败:', error);
        }

        if (removedAssetKeys.length > 0 || portfolioChanged) {
            this.logger.success(`资产池已迁移为纯外汇，移除: ${removedAssetKeys.join(', ') || '旧持仓'}`);
        }
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
            await this.updateAIContext();
            await this.runInitialBootstrapIfNeeded();
            this.ui.renderInitializationProgress({
                step: '完成',
                title: '初始化完成',
                detail: '正在打开交易面板。',
                percent: 100,
            });
            this.ui.renderMainInterface();
            this.dependencies.app?.syncAutoAdvanceFromConfig();
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
        await this._migrateAssetUniverse(lorebookName);
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
                entry = { name: key, content: '', enabled: this._isWorldbookEntryVisibleToRoleAI(key) };
                this._insertWorldbookEntry(entries, entry, this._getPreferredAfterKey(key));
            }
            if (entry) {
                entry.content = JSON.stringify(newState, null, 2);
                entry.enabled = this._isWorldbookEntryVisibleToRoleAI(key);
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
        if (key === keys.market_overview) return keys.dialogue_context;
        if (key === keys.market_targets) return keys.market_overview;
        return null;
    }

    _isWorldbookEntryVisibleToRoleAI(key) {
        const keys = this.config.world_book_keys;
        const internalKeys = new Set([
            keys.config,
            keys.global_market,
            keys.player_portfolio,
            keys.ai_context,
            keys.kline_context,
            keys.market_overview,
            keys.market_targets,
            keys.news_archive,
            keys.active_market_news,
        ]);
        return !internalKeys.has(key)
            && !String(key || '').startsWith(keys.asset_prefix);
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
            !this._stateCache.has(keys.market_overview) ||
            !this._stateCache.has(keys.market_targets) ||
            !this._stateCache.has(keys.news_archive) ||
            !this._stateCache.has(keys.active_market_news);

        if (!needsEnsure) return;

        await this.ensureContextEntries(lorebookName);
        this.contextEntriesEnsuredFor = lorebookName;
    }

    async ensureContextEntries(lorebookName) {
        const klineKey = this.config.world_book_keys.kline_context;
        await this.th.updateWorldbookWith(lorebookName, entries => entries.filter(entry => entry.name !== klineKey));
        this._stateCache.delete(klineKey);
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.dialogue_context,
            this.config.default_game_state.dialogue_context
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.market_overview,
            this.config.default_game_state.market_overview,
            { enabled: false, afterKey: this.config.world_book_keys.dialogue_context }
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.market_targets,
            this.config.default_game_state.market_targets,
            { afterKey: this.config.world_book_keys.market_overview }
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.news_archive,
            this.config.default_game_state.news_archive,
            { enabled: false, afterKey: this.config.world_book_keys.market_targets }
        );
        await this.ensureContextEntry(
            lorebookName,
            this.config.world_book_keys.active_market_news,
            this.config.default_game_state.active_market_news,
            { enabled: false, afterKey: this.config.world_book_keys.news_archive }
        );
    }

    async ensureContextEntry(lorebookName, key, defaultState, options = {}) {
        const defaultContent = JSON.stringify(defaultState, null, 2);
        const enabled = options.enabled ?? this._isWorldbookEntryVisibleToRoleAI(key);

        await this.th.updateWorldbookWith(lorebookName, entries => {
            const entry = entries.find(item => item.name === key);
            if (entry) {
                entry.enabled = enabled;
            } else {
                const newEntry = { name: key, content: defaultContent, enabled };
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
                    if (!this._isWorldbookEntryVisibleToRoleAI(entry.name)) {
                        entry.enabled = false;
                    }
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

    _normalizeRoleAISettings(settings = {}) {
        const normalized = {
            ...this.config.role_ai_defaults,
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
            role_ai: this._normalizeRoleAISettings(options.roleAI || defaults.config.role_ai),
            auto_advance: {
                ...defaults.config.auto_advance,
                ...(options.autoAdvance || {}),
            },
        };

        const initialGlobalMarket = { ...defaults.global_market };

        const entriesTemplate = [
            { name: keys.config, content: JSON.stringify(initialConfig, null, 2), enabled: false },
            { name: keys.global_market, content: JSON.stringify(initialGlobalMarket, null, 2), enabled: false },
            { name: keys.player_portfolio, content: JSON.stringify(defaults.player_portfolio, null, 2), enabled: false },
            { name: keys.ai_context, content: JSON.stringify(defaults.ai_context, null, 2), enabled: false },
            { name: keys.dialogue_context, content: JSON.stringify(defaults.dialogue_context, null, 2), enabled: true },
            { name: keys.market_overview, content: JSON.stringify(defaults.market_overview, null, 2), enabled: false },
            { name: keys.market_targets, content: JSON.stringify(defaults.market_targets, null, 2), enabled: false },
            { name: keys.news_archive, content: JSON.stringify(defaults.news_archive, null, 2), enabled: false },
            { name: keys.active_market_news, content: JSON.stringify(defaults.active_market_news, null, 2), enabled: false },
        ];

        initialConfig.available_assets.forEach(assetCode => {
            const assetDef = this.config.asset_definitions[assetCode];
            if (assetDef) {
                const initialAssetData = this._buildInitialAssetData(assetDef);
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
        this.dependencies.app?.syncAutoAdvanceFromConfig();
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
        const preservedRoleAI = this._normalizeRoleAISettings(configState.role_ai);
        const preservedAutoAdvance = {
            ...this.config.default_game_state.config.auto_advance,
            ...(configState.auto_advance || {}),
        };
        await this.createInitialWorldState({
            backgroundAI: preservedBackgroundAI,
            roleAI: preservedRoleAI,
            autoAdvance: preservedAutoAdvance,
        }); // Re-running the creation process effectively resets everything.
        this.dependencies.win.toastr.success("所有数据已重置到初始状态，后台市场与角色模型设置已保留。");
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
                for (const position of Object.values(this.positionCalculator.calculateAll(assetCode, portfolio))) {
                    if (!position.type || position.totalAmount <= 0) continue;
                    const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
                    const lastPrice = assetData?.current_price ?? position.avgEntryPrice;
                    const pnl = position.type === 'short'
                        ? (position.avgEntryPrice - lastPrice) * position.totalShares
                        : (lastPrice - position.avgEntryPrice) * position.totalShares;
                    positionValue += position.totalAmount + pnl;
                }
            }
        }

        return (portfolio.cash || 0) + positionValue - (portfolio.debt || 0);
    }

    getArchivedNews() {
        const state = this.getState(this.config.world_book_keys.news_archive) || {};
        return Array.isArray(state.items) ? state.items : [];
    }

    getActiveMarketNews() {
        const state = this.getState(this.config.world_book_keys.active_market_news) || {};
        return Array.isArray(state.items) ? state.items : [];
    }

    async pruneExpiredActiveNews() {
        const key = this.config.world_book_keys.active_market_news;
        const state = this.getState(key) || this.config.default_game_state.active_market_news;
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const currentTime = Number(market.current_time_index || 0);
        const items = Array.isArray(state.items) ? state.items : [];
        const activeItems = items.filter(item => Number(item.expires_at || 0) > currentTime);
        if (activeItems.length === items.length) return activeItems;

        await this.updateState(key, current => ({
            ...current,
            updated_at: currentTime,
            items: activeItems,
        }));
        return activeItems;
    }

    async recordMarketNews(headline, assetCode = 'GLOBAL', durationHours = 6, createdAt = null) {
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const timeIndex = Number(createdAt ?? market.current_time_index ?? 0);
        const normalizedAssetCode = this.config.asset_definitions[assetCode] ? assetCode : 'GLOBAL';
        const item = this._normalizeNewsItem({
            headline,
            asset_code: normalizedAssetCode,
            created_at: timeIndex,
            duration_hours: durationHours,
        }, timeIndex, durationHours);
        if (!item) return null;

        const archiveKey = this.config.world_book_keys.news_archive;
        const activeKey = this.config.world_book_keys.active_market_news;
        await this.updateState(archiveKey, state => ({
            ...state,
            updated_at: timeIndex,
            items: this._mergeNewsItems(state.items || [], [item]),
        }));
        await this.updateState(activeKey, state => ({
            ...state,
            updated_at: timeIndex,
            items: this._mergeNewsItems(state.items || [], [item])
                .filter(news => Number(news.expires_at || 0) > timeIndex),
        }));
        return item;
    }

    async updateAIContext() {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const market = this.getState(keys.global_market) || {};
        const portfolio = this.getState(keys.player_portfolio) || {};
        const availableAssets = configState?.available_assets || Object.keys(this.config.asset_definitions);
        await this.pruneExpiredMarketTargets();
        await this.pruneExpiredActiveNews();

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

        await this.updateState(keys.ai_context, context => {
            const {
                active_market_targets,
                market_targets,
                ...safeContext
            } = context || {};

            return {
                ...safeContext,
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
            };
        });
        await this.updateMarketOverview(availableAssets, market);
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

    _classifyOverviewPhase(summary) {
        if (summary.breakout === 'up') return 'breakout_up';
        if (summary.breakout === 'down') return 'breakout_down';
        if (summary.direction === 'up') return summary.momentum > 0 ? 'accelerating_up' : 'rising';
        if (summary.direction === 'down') return summary.momentum > 0 ? 'accelerating_down' : 'falling';
        return 'consolidation';
    }

    _buildMarketOverviewAssets(assetCodes) {
        return assetCodes.map(assetCode => {
            const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
            const candles = (assetData?.kline_hourly || []).filter(Boolean).slice(-24);
            const first = candles[0] || {};
            const last = candles[candles.length - 1] || {};
            const open = Number(first.open || first.close || assetData?.current_price || 0);
            const close = Number(last.close || assetData?.current_price || open);
            const high = candles.length > 0
                ? Math.max(...candles.map(candle => Number(candle.high || candle.close || 0)))
                : close;
            const low = candles.length > 0
                ? Math.min(...candles.map(candle => Number(candle.low || candle.close || close)))
                : close;
            const summary = this._summarizeCandleWindow(candles);
            const compact = value => Number(Number(value || 0).toFixed(4));

            return {
                code: assetCode,
                hours: candles.length,
                o: compact(open),
                h: compact(high),
                l: compact(low),
                c: compact(close),
                change_pct: Number((open > 0 ? ((close / open) - 1) * 100 : 0).toFixed(3)),
                range_pct: Number((open > 0 ? ((high - low) / open) * 100 : 0).toFixed(3)),
                trend: summary.direction,
                phase: this._classifyOverviewPhase(summary),
                consecutive_up: summary.consecutive_up,
                consecutive_down: summary.consecutive_down,
                recent_closes: candles.slice(-4).map(candle => compact(candle.close)),
            };
        });
    }

    async updateMarketOverview(availableAssets = null, market = null) {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const resolvedAssets = availableAssets || configState?.available_assets || Object.keys(this.config.asset_definitions);
        const selectedAssets = this._selectKlineContextAssets(resolvedAssets);
        const resolvedMarket = market || this.getState(keys.global_market) || {};

        await this.updateState(keys.market_overview, () => ({
            comment: "Compact 24-hour summaries for the background market AI. No minute candles or account data.",
            updated_at: resolvedMarket.current_time_index || 0,
            window_hours: 24,
            selected_assets: selectedAssets,
            assets: this._buildMarketOverviewAssets(selectedAssets),
        }));
    }

    getMarketOverview(assetCodes = null) {
        const keys = this.config.world_book_keys;
        const overview = this.getState(keys.market_overview) || this.config.default_game_state.market_overview;
        const selected = Array.isArray(assetCodes) ? new Set(assetCodes) : null;

        return {
            window_hours: 24,
            assets: (overview.assets || []).filter(asset => !selected || selected.has(asset.code)),
        };
    }

    _buildRecentKlineSnapshot(assetCode, assetData) {
        const mapRecent = candles => (candles || []).slice(-8).map(candle => this._compactCandle(candle));

        return {
            code: assetCode,
            columns: ['t', 'o', 'h', 'l', 'c'],
            m1: mapRecent(assetData?.kline_minute),
            h1: mapRecent(assetData?.kline_hourly),
        };
    }

    _getActiveTargetForSignal(assetCode, type, market, targetState) {
        const target = targetState?.targets?.[assetCode]?.[type];
        if (!target) return null;
        const currentIndex = type === 'long'
            ? Number(market?.current_time_index || 0)
            : Number(market?.minute_time_index || 0);
        const endIndex = type === 'long' ? Number(target.end_time) : Number(target.end_minute);
        return endIndex > currentIndex ? target : null;
    }

    _summarizeCandleWindow(candles = []) {
        const list = candles.filter(Boolean);
        if (list.length < 2) {
            return {
                change_pct: 0,
                direction: 'flat',
                momentum: 0,
                volatility_pct: 0,
                consecutive_up: 0,
                consecutive_down: 0,
                volume_ratio: 1,
                breakout: 'none',
            };
        }

        const first = list[0];
        const last = list[list.length - 1];
        const start = Number(first.open || first.close || 0);
        const end = Number(last.close || 0);
        const changePct = start > 0 ? ((end / start) - 1) * 100 : 0;
        const direction = changePct > 0.08 ? 'up' : (changePct < -0.08 ? 'down' : 'flat');
        const ranges = list.map(candle => {
            const close = Number(candle.close || 0);
            const high = Number(candle.high || close);
            const low = Number(candle.low || close);
            return close > 0 ? ((high - low) / close) * 100 : 0;
        });
        const volatilityPct = ranges.reduce((sum, item) => sum + item, 0) / Math.max(1, ranges.length);
        let consecutiveUp = 0;
        let consecutiveDown = 0;
        for (let i = list.length - 1; i >= 0; i--) {
            const candle = list[i];
            if (Number(candle.close) > Number(candle.open)) {
                if (consecutiveDown > 0) break;
                consecutiveUp++;
            } else if (Number(candle.close) < Number(candle.open)) {
                if (consecutiveUp > 0) break;
                consecutiveDown++;
            } else {
                break;
            }
        }

        const prev = list.slice(0, -1);
        const prevHigh = Math.max(...prev.map(candle => Number(candle.high || candle.close || 0)));
        const prevLow = Math.min(...prev.map(candle => Number(candle.low || candle.close || Infinity)));
        const breakout = Number(last.close) > prevHigh ? 'up' : (Number(last.close) < prevLow ? 'down' : 'none');
        const recentVolumes = list.slice(-3).map(candle => Number(candle.volume || 0));
        const earlierVolumes = list.slice(0, Math.max(1, list.length - 3)).map(candle => Number(candle.volume || 0));
        const avgRecentVolume = recentVolumes.reduce((sum, item) => sum + item, 0) / Math.max(1, recentVolumes.length);
        const avgEarlierVolume = earlierVolumes.reduce((sum, item) => sum + item, 0) / Math.max(1, earlierVolumes.length);
        const volumeRatio = avgEarlierVolume > 0 ? avgRecentVolume / avgEarlierVolume : 1;
        const firstHalf = list.slice(0, Math.ceil(list.length / 2));
        const secondHalf = list.slice(Math.floor(list.length / 2));
        const firstMove = Number(firstHalf[firstHalf.length - 1]?.close || 0) - Number(firstHalf[0]?.open || firstHalf[0]?.close || 0);
        const secondMove = Number(secondHalf[secondHalf.length - 1]?.close || 0) - Number(secondHalf[0]?.open || secondHalf[0]?.close || 0);
        const momentum = Math.sign(secondMove) === Math.sign(firstMove)
            ? Math.abs(secondMove) - Math.abs(firstMove)
            : secondMove;

        return {
            change_pct: Number(changePct.toFixed(3)),
            direction,
            momentum: Number(momentum.toFixed(6)),
            volatility_pct: Number(volatilityPct.toFixed(3)),
            consecutive_up: consecutiveUp,
            consecutive_down: consecutiveDown,
            volume_ratio: Number(volumeRatio.toFixed(2)),
            breakout,
        };
    }

    getKlineSignal(assetCode) {
        const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        const targetState = this.getMarketTargets();
        const minuteSummary = this._summarizeCandleWindow((assetData?.kline_minute || []).slice(-15));
        const hourlySummary = this._summarizeCandleWindow((assetData?.kline_hourly || []).slice(-8));
        const longTarget = this._getActiveTargetForSignal(assetCode, 'long', market, targetState);
        const shortTarget = this._getActiveTargetForSignal(assetCode, 'short', market, targetState);

        const scorePart = direction => direction === 'up' ? 1 : (direction === 'down' ? -1 : 0);
        const minuteScore = scorePart(minuteSummary.direction) + (minuteSummary.breakout === 'up' ? 0.6 : (minuteSummary.breakout === 'down' ? -0.6 : 0));
        const hourlyScore = scorePart(hourlySummary.direction) * 1.15 + (hourlySummary.breakout === 'up' ? 0.45 : (hourlySummary.breakout === 'down' ? -0.45 : 0));
        const targetScore =
            (longTarget ? (Number(longTarget.target_price) >= Number(assetData?.current_price || 0) ? 0.9 : -0.9) : 0) +
            (shortTarget ? (Number(shortTarget.target_price) >= Number(assetData?.current_price || 0) ? 1.1 : -1.1) : 0);
        const combinedScore = minuteScore * 1.2 + hourlyScore + targetScore;
        const combinedBias = combinedScore > 1.1 ? 'bullish' : (combinedScore < -1.1 ? 'bearish' : 'neutral');
        const volatilityLevel = minuteSummary.volatility_pct > 0.8 || minuteSummary.volume_ratio > 1.8
            ? 'high'
            : (minuteSummary.volatility_pct > 0.25 || minuteSummary.volume_ratio > 1.25 ? 'medium' : 'low');
        const targetAlignment = shortTarget
            ? (Math.sign(targetScore) === Math.sign(minuteScore || targetScore) ? 'aligned_short_target' : 'conflicting_short_target')
            : (longTarget ? (Math.sign(targetScore) === Math.sign(hourlyScore || targetScore) ? 'aligned_long_target' : 'conflicting_long_target') : 'no_active_target');

        return {
            asset_code: assetCode,
            minute: minuteSummary,
            hourly: hourlySummary,
            combined_bias: combinedBias,
            volatility_level: volatilityLevel,
            target_alignment: targetAlignment,
            active_targets: {
                long: longTarget ? {
                    target_price: longTarget.target_price,
                    end_time: longTarget.end_time,
                    pattern: longTarget.pattern,
                    confidence: longTarget.confidence,
                } : null,
                short: shortTarget ? {
                    target_price: shortTarget.target_price,
                    end_minute: shortTarget.end_minute,
                    pattern: shortTarget.pattern,
                    confidence: shortTarget.confidence,
                } : null,
            },
            instruction: '短线交易必须同时参考 minute 与 hourly；minute 可决定入场节奏，hourly 与 active_targets 决定方向过滤。若 target_alignment 为 conflicting_*，优先按 AI 目标方向等待或降低仓位，不要让分K走势长期违背目标。',
        };
    }

    _selectKlineContextAssets(availableAssets) {
        const configuredAssets = Array.isArray(availableAssets) ? availableAssets : [];
        return [...new Set(configuredAssets)].filter(assetCode => this.config.asset_definitions[assetCode]);
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
            for (const [mode, position] of Object.entries(this.positionCalculator.calculateAll(assetCode, portfolio))) {
                if (!position.type || position.totalAmount <= 0) continue;
                const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = assetData?.current_price ?? position.avgEntryPrice;
                const pnl = position.type === 'short'
                    ? (position.avgEntryPrice - lastPrice) * position.totalShares
                    : (lastPrice - position.avgEntryPrice) * position.totalShares;
                const pnlPct = position.totalAmount > 0 ? (pnl / position.totalAmount) * 100 : 0;
                const direction = position.type === 'short' ? '空头' : '多头';
                const modeLabel = mode === 'spot' ? '现货' : `杠杆 ${position.leverage}x`;
                const riskControls = portfolio.assets?.[assetCode]?.[mode]?.risk_controls || {};
                const takeProfit = Number(riskControls.take_profit);
                const stopLoss = Number(riskControls.stop_loss);
                const riskText = [
                    Number.isFinite(takeProfit) && takeProfit > 0 ? `止盈 ${takeProfit.toFixed(4)}` : '止盈 未设置',
                    Number.isFinite(stopLoss) && stopLoss > 0 ? `止损 ${stopLoss.toFixed(4)}` : '止损 未设置',
                ].join('，');
                lines.push(`- ${assetCode} ${modeLabel}: ${direction}，本金/保证金 ${position.totalAmount.toFixed(2)}，入场 ${position.avgEntryPrice.toFixed(4)}，现价 ${lastPrice.toFixed(4)}，${riskText}，未实现盈亏 ${this._formatSigned(pnl)} (${this._formatSigned(pnlPct)}%)`);
            }
        }

        return lines.length > 0 ? lines : ['- 当前没有持仓。'];
    }

    async updateDialogueContext(_existingMarketSummary = null) {
        const keys = this.config.world_book_keys;
        const configState = this.getState(keys.config);
        const market = this.getState(keys.global_market) || {};
        const portfolio = this.getState(keys.player_portfolio) || {};
        const availableAssets = configState?.available_assets || Object.keys(this.config.asset_definitions);

        const transactionLines = (portfolio.transaction_log || []).slice(0, 3).map(log =>
            `- [t=${log.time}] ${log.description}: ${this._formatSigned(log.amount)}`
        );
        const totalNetWorth = this._calculatePortfolioMarkedValue(portfolio);

        const lines = [
            '【SillyView 市场同步摘要】',
            '用途：这是给普通对话 AI 阅读的市场状态摘要，用于让角色知道交易世界发生了什么。不要把它当作用户发言。',
            '',
            `时间：${market.current_datetime || '未知'} / ${market.current_period || '未知'} / ${market.current_season || '未知'} / 天气：${market.current_weather || '未知'}`,
            `市场状态：${market.market_status || 'OPEN'}，市场性格：${market.personality_state || '未知'}。`,
            '',
            '账户：',
            `- 现金：${Number(portfolio.cash || 0).toFixed(2)}`,
            `- 债务：${Number(portfolio.debt || 0).toFixed(2)}`,
            `- 估算净值：${Number(totalNetWorth || 0).toFixed(2)}`,
            '',
            '持仓：',
            ...this._buildPositionSummary(portfolio),
            '',
            '近期资金/交易记录：',
            ...(transactionLines.length > 0 ? transactionLines : ['- 暂无记录。']),
            '',
            '对话使用建议：角色可以自然提及账户状态、持仓和盈亏压力，但不要在普通对话中擅自输出市场指令。行情判断请读取独立的 sv_kline_context。',
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
        const resolvedMarket = market || this.getState(keys.global_market) || {};
        const klineAssetCodes = this._selectKlineContextAssets(resolvedAssets);
        const recentKlines = this._buildRecentKlineContext(klineAssetCodes);

        this._stateCache.set(keys.kline_context, {
            comment: "Compact K-line context for market judgment. Use columns=[t,o,h,l,c].",
            updated_at: resolvedMarket.current_time_index || 0,
            updated_minute_at: resolvedMarket.minute_time_index || 0,
            selected_assets: klineAssetCodes,
            assets: recentKlines,
        });
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

    _extractRoleProfilesFromEntry(entry, worldbookName) {
        const content = String(entry?.content || '');
        const marker = this.config.multi_account.role_profile_import_marker;
        if (!marker || !content.includes(marker)) return [];

        const profiles = [];
        const tagPattern = /<([^\s<>/"'=]+)>([\s\S]*?)<\/\1\s*>/g;
        let match;
        while ((match = tagPattern.exec(content)) !== null) {
            const roleName = String(match[1] || '').trim();
            const profileContent = String(match[2] || '').trim();
            if (!roleName || !profileContent) continue;
            profiles.push({
                role_name: roleName,
                content: `<${roleName}>\n${profileContent}\n</${roleName}>`,
                source_worldbook: worldbookName,
                source_entry: entry?.name || 'unknown',
            });
        }
        return profiles;
    }

    async scanBoundRoleProfiles() {
        const scanInfo = await this._getBankAccountScanTargets();
        const profilesByName = new Map();
        for (const worldbookName of scanInfo.targets) {
            let entries = [];
            try {
                entries = await this.th.getWorldbook(worldbookName);
            } catch (error) {
                this.logger.warn(`扫描角色人设世界书失败: ${worldbookName}`, error);
                continue;
            }
            for (const entry of entries || []) {
                for (const profile of this._extractRoleProfilesFromEntry(entry, worldbookName)) {
                    if (!profilesByName.has(profile.role_name)) profilesByName.set(profile.role_name, profile);
                }
            }
        }
        return [...profilesByName.values()];
    }

    async syncBoundRoleProfiles() {
        const profiles = await this.scanBoundRoleProfiles();
        const controlName = this.config.multi_account.control_worldbook_name;
        const prefix = `${this.config.multi_account.role_profile_prefix}_`;
        await this._ensureWorldbookExists(controlName, []);
        await this.th.updateWorldbookWith(controlName, entries => {
            const retained = entries.filter(entry => !String(entry.name || '').startsWith(prefix));
            for (const profile of profiles) {
                retained.push({
                    name: `${prefix}${this._sanitizeName(profile.role_name)}_${this._hashString(profile.role_name)}`,
                    enabled: false,
                    content: profile.content,
                });
            }
            return retained;
        });
        return profiles;
    }

    async getManagedRoleProfiles() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const prefix = `${this.config.multi_account.role_profile_prefix}_`;
        try {
            const entries = await this.th.getWorldbook(controlName);
            return (entries || [])
                .filter(entry => String(entry.name || '').startsWith(prefix) && String(entry.content || '').trim())
                .map(entry => ({ entry_name: entry.name, content: String(entry.content).trim() }));
        } catch (error) {
            this.logger.warn('读取角色人设条目失败。', error);
            return [];
        }
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
            version: 3,
            account_id: account.account_id,
            owner_name: account.owner_name,
            bank_name: account.bank_name,
            bank_account_no: account.bank_account_no,
            worldbook_name: this.config.multi_account.control_worldbook_name,
            state_entry_name: stateEntryName,
            portfolio,
            recent_major_events: [],
            created_at: Date.now(),
            updated_at: Date.now(),
        };
    }

    _parseManagedAccountStateFromEntries(entries, stateEntryName) {
        const stateEntry = (entries || []).find(entry => entry.name === stateEntryName);
        if (!stateEntry?.content) return null;
        const state = JSON.parse(stateEntry.content);
        delete state.source_worldbook;
        delete state.source_entry;
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
            delete state.source_worldbook;
            delete state.source_entry;
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
            }, null, 2), false);
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
                this._migratePortfolioPositionBuckets(state.portfolio);
                this._ensurePendingOrderShape(state.portfolio);
                state.version = 3;
                if (!Array.isArray(state.recent_major_events)) state.recent_major_events = [];
                state.worldbook_name = controlName;
                state.state_entry_name = stateEntryName;
                this._upsertWorldbookEntry(entries, stateEntryName, JSON.stringify(state, null, 2), false);
                return entries;
            }

            try {
                const state = JSON.parse(stateEntry.content);
                this._migratePortfolioPositionBuckets(state.portfolio);
                this._ensurePendingOrderShape(state.portfolio);
                state.version = 3;
                if (!Array.isArray(state.recent_major_events)) state.recent_major_events = [];
                state.owner_name = state.owner_name || account.owner_name;
                state.bank_name = state.bank_name || account.bank_name;
                state.bank_account_no = state.bank_account_no || account.bank_account_no;
                delete state.source_worldbook;
                delete state.source_entry;
                state.worldbook_name = controlName;
                state.state_entry_name = stateEntryName;
                state.updated_at = Date.now();
                stateEntry.content = JSON.stringify(state, null, 2);
            } catch (error) {
                stateEntry.content = JSON.stringify(initialState, null, 2);
            }
            stateEntry.enabled = false;
            return entries;
        });

        return {
            account_id: account.account_id,
            owner_name: account.owner_name,
            bank_name: account.bank_name,
            worldbook_name: controlName,
            state_entry_name: stateEntryName,
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
                state.version = 3;
                state.state_entry_name = stateEntryName;
                state.worldbook_name = controlName;
                if (!Array.isArray(state.recent_major_events)) state.recent_major_events = [];
                this._migratePortfolioPositionBuckets(state.portfolio);
                this._ensurePendingOrderShape(state.portfolio);
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
        delete state.source_worldbook;
        delete state.source_entry;
        state.updated_at = Date.now();
        state.worldbook_name = controlName;
        state.state_entry_name = stateEntryName;
        this._ensurePendingOrderShape(state.portfolio);
        if (!Array.isArray(state.recent_major_events)) state.recent_major_events = [];
        await this._ensureWorldbookExists(controlName, [{
            name: stateEntryName,
            enabled: false,
            content: JSON.stringify(state, null, 2),
        }]);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, stateEntryName, JSON.stringify(state, null, 2), false);
            return entries;
        });
    }

    _buildManagedTradeCommandGuide(states = []) {
        const accountDirectory = states.length > 0
            ? states.map(state => `- ${state.account_id} | ${state.owner_name || '未知户名'} | ${state.bank_name || '未知开户行'}`)
            : ['- 暂无可用账户'];
        return [
            '【SillyView 多账户交易指令】',
            '用途：让角色 AI 先根据人设和当前剧情判断角色是否会查看手机或账户，再操作彼此独立的账户。默认情况下账户实况和行情均不可见，不得假定角色知道未观察的数据。',
            '输出规则：所有观察和交易指令放在回复末尾唯一的 <command>...</command> 块中，一行一条；不要把指令写在正文或代码块里。账户编号必须原样使用下方目录中的 account_id。',
            '',
            '账户目录（只提供身份，不代表角色已经查看余额、持仓或近期事件）：',
            ...accountDirectory,
            '',
            '观察指令：',
            '[Observe.Account("account_id")]：该角色决定查看自己的账户；系统将在下一次请求中临时提供该账户实况、持仓及近期重大事件，并附带一份 sv_kline_context。',
            '[Observe.Market()]：角色只查看市场行情；系统将在下一次请求中临时提供一份 sv_kline_context。',
            '[Observe.Combined("account_id")]：同时查看指定账户和市场，效果等同于 Account；多个不同角色查看时逐行输出各自的 account_id。',
            '同一轮可输出任意多个不同账户的观察指令；系统会去重并合并为一次后续请求，sv_kline_context 只发送一份。无人查看时不要输出 Observe 指令。',
            '首次请求中如果账户和行情实况尚不可见，只能输出观察意图，不能凭空生成交易指令；收到观察数据后的后续请求才可交易。',
            '',
            '普通交易参数顺序：("account_id", "asset_code", amount, leverage, take_profit, stop_loss, trailing_stop_pct)。',
            '- amount：杠杆指令中是本次投入的保证金，现货指令中是买入金额；必须大于 0 且不能超过账户可用现金。',
            '- leverage：整数杠杆，最低 1，超过该资产上限时会自动压到上限；杠杆会放大盈利、亏损和爆仓风险。',
            '- take_profit / stop_loss：触发价格，填 0 表示不设置。多头止盈应高于现价、止损应低于现价；空头相反。',
            '- trailing_stop_pct：移动止损百分比，范围 0-50；填 0 表示不设置。多头随新高上移，空头随新低下移。',
            '- 手续费会额外从现金扣除。开仓方向与已有反向仓位冲突时，明确的 Open/Add 指令会失败，应先平掉反向仓位。',
            '',
            '明确操作（推荐，语义不会随现有仓位变化）：',
            '[Trade.OpenLong("account_id", "EURUSD", 1000, 5, 1.1000, 1.0600, 1.0)]：无仓位时开多，并设置1%移动止损。',
            '[Trade.AddLong("account_id", "EURUSD", 500, 5, 1.1000, 1.0600, 0)]：给已有多头加仓。',
            '[Trade.CloseLong("account_id", "EURUSD")]：全额平掉该货币对多头，amount 等参数无需填写。',
            '[Trade.OpenShort("account_id", "GBPUSD", 1000, 5, 1.2300, 1.3100, 1.0)]：无仓位时开空，并设置1%移动止损。',
            '[Trade.AddShort("account_id", "GBPUSD", 500, 5, 1.2300, 1.3100, 0)]：给已有空头加仓。',
            '[Trade.CloseShort("account_id", "GBPUSD")]：全额平掉该货币对空头，amount 等参数无需填写。',
            '[Trade.SpotBuy("account_id", "EURUSD", 1000, 0, 1.1000, 1.0600, 1.0)]：买入或加仓现货，不产生杠杆和强平价。',
            '[Trade.SpotSell("account_id", "EURUSD")]：全额卖出现货，amount 等参数无需填写。',
            '[Trade.SetRisk("account_id", "EURUSD", 1.1050, 1.0550, 1.0)]：调整已有杠杆仓的止盈、止损和移动止损；对应值填 0 可清空。',
            '[Trade.SetSpotRisk("account_id", "EURUSD", 1.1050, 1.0550, 1.0)]：调整现货仓位的止盈、止损和移动止损。',
            '',
            '挂单操作：side 只能是 "buy" 或 "sell"；mode 只能是 "leveraged" 或 "spot"。挂单不预占现金，触发时重新校验余额和持仓。',
            '[Trade.PlaceLimit("account_id", "EURUSD", "buy", "leveraged", 1000, 5, 1.0700, 1.1100, 1.0500, 1.0)]：创建限价单；买入限价低于现价，卖出限价高于现价。',
            '[Trade.PlaceStop("account_id", "EURUSD", "buy", "leveraged", 1000, 5, 1.0900, 1.1200, 1.0600, 1.0)]：创建条件单；买入触发价高于现价，卖出触发价低于现价。',
            '[Trade.PlaceOCO("account_id", "EURUSD", "buy", "leveraged", 1000, 5, 1.0700, 1.0900, 1.1200, 1.0500, 1.0)]：创建下轨和上轨 OCO，任一成交后自动撤销另一单。',
            '[Trade.CancelOrder("account_id", "ord_xxx")]：撤销已观察账户 pending_orders 中指定 id 的挂单；不得编造订单编号。',
            'PlaceLimit/PlaceStop 参数末尾依次为 trigger_price, take_profit, stop_loss, trailing_stop_pct；PlaceOCO 依次为 lower_price, upper_price, take_profit, stop_loss, trailing_stop_pct。',
            '',
            '快捷操作（行为取决于当前仓位）：',
            '[Trade.Buy("account_id", "EURUSD", 1000, 5, 1.1000, 1.0600, 0)]：无仓位则开多，已有多头则加多，已有空头则全额平空。',
            '[Trade.Sell("account_id", "GBPUSD", 500, 5, 1.2300, 1.3100, 0)]：无仓位则开空，已有空头则加空，已有多头则全额平多。',
            '使用 Buy/Sell 平仓时，amount、leverage、止盈和止损参数会被忽略；为避免误判，平仓优先使用 CloseLong/CloseShort。',
            '',
            '多账户示例：',
            '<command>',
            '[Trade.OpenLong("acct_example_a", "EURUSD", 1000, 5, 1.1000, 1.0600, 1.0)]',
            '[Trade.PlaceOCO("acct_example_b", "GBPUSD", "sell", "leveraged", 800, 5, 1.2500, 1.2900, 1.2200, 1.3100, 1.0)]',
            '[Trade.SetRisk("acct_example_c", "USDJPY", 152.00, 0, 0.8)]',
            '</command>',
            '只输出确实要执行的操作；观望时不要生成交易指令。每个账户独立判断、独立计算资金和持仓，不得混用 account_id。交易指令只能依据本轮实际观察到的数据。',
        ].join('\n');
    }

    _buildRoleOutputRules() {
        return [
            '【SillyView 角色 AI 输出规范】',
            '你是幕后角色决策 AI，不是前台正文写作者。角色索引中的所有人物都是你需要依据对应人设分别扮演的角色。你的任务只有：进入相关角色自身意识模拟内心活动；在确有必要时代替对应角色使用 SillyView 观察或交易指令；最后为前台对话 AI 提供各角色接下来可能发生的简短剧情大纲。',
            '角色心理和下一步行动默认应承接当前正文剧情，而不是默认评价 FX。观察市场、账户或交易只是与剧情及角色动机相关时才使用的可选支线；正文与 FX 无关时，必须聚焦人物关系、情绪、冲突和剧情行动，禁止硬塞行情、货币、交易或账户内容。',
            '禁止续写正文、对白、旁白、场景描写、寒暄、解释或总结。不要向用户说话，不要复述本规范。',
            '',
            '严格输出结构：',
            '<role_thoughts>',
            '  <role_thought role="角色名">以“我”表达、符合该角色性格的第一人称内心独白</role_thought>',
            '  <role_thought role="另一角色名">以“我”表达的另一角色独立内心独白</role_thought>',
            '</role_thoughts>',
            '<plot_outlines>',
            '  <role_outline role="角色名">该角色接下来可能采取的行动及剧情走向</role_outline>',
            '  <role_outline role="另一角色名">另一角色接下来可能采取的行动及剧情走向</role_outline>',
            '</plot_outlines>',
            '<command>',
            '[Module.Action(...)]',
            '</command>',
            '',
            '标签与角色规则：',
            '- 本轮实际出场、明确被提及或会直接受影响的每个角色，都必须分别拥有一个 role_thought 和一个同名 role_outline；不得把多人内容合并在同一标签中。',
            '- role 属性必须使用人设中的准确角色名。角色之间的认知、动机、账户和指令必须相互独立。',
            '- 每个 role_thought 必须像该角色正在心里思考一样使用第一人称“我”，并体现其性格、措辞、欲望和认知局限；禁止第三人称概述、上帝视角分析或“该角色认为/他感到/她打算”式报告。',
            '- 第一人称只用于标签内的角色心理，不得把多个角色混成同一个“我”；role 属性负责标明这段“我”属于谁。',
            '- 不要为纯背景人物生成标签；单轮最多输出 6 个角色，超过时只保留与本轮剧情最相关者。',
            '- 标签外不得输出任何文字，也不要使用 Markdown 代码块。',
            '',
            '指令规则：',
            '- 所有完整指令只能逐行放在回复末尾唯一的 <command>...</command> 中，command 之后不得再有任何内容。',
            '- 每条指令中的 account_id 必须属于作出该决定的角色；不得混用角色身份、账户或观察结果。',
            '- 没有必要执行指令时仍保留空的 <command></command>，不得编造操作。',
            '- role_thought、role_outline 或其他位置不得出现完整或示例形式的 [Module.Action(...)] 指令。',
            '',
            '字数限制：',
            '- 每个 role_thought 为 30-80 个汉字，以第一人称聚焦内心判断、情绪和动机，不重复人设或上下文。',
            '- 每个 role_outline 为 20-60 个汉字，只写 1-2 个最可能的下一步剧情节点，不扩写正文。',
            '- 除 command 内的指令外，全部输出合计不得超过 900 个汉字；冲突时优先缩短措辞，不能省略必要标签。',
        ].join('\n');
    }

    async getManagedRolePromptGuides() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const states = await this.getManagedAccountStates();
        const fallback = {
            command_guide: this._buildManagedTradeCommandGuide(states),
            output_rules: this._buildRoleOutputRules(),
        };
        try {
            const entries = await this.th.getWorldbook(controlName);
            const readEntry = key => String(entries.find(entry => entry.name === key)?.content || '').trim();
            return {
                command_guide: readEntry(this.config.multi_account.command_entry_key) || fallback.command_guide,
                output_rules: readEntry(this.config.multi_account.role_output_rules_key) || fallback.output_rules,
            };
        } catch (error) {
            this.logger.warn('读取 SillyView_accounts 角色提示词条目失败，使用内置规范。', error);
            return fallback;
        }
    }

    _buildManagedControlEntries(states, accountEntries = null) {
        const klineContext = this.getState(this.config.world_book_keys.kline_context) || this.config.default_game_state.kline_context;
        const entries = [];
        if (accountEntries) {
            entries.push({
                name: this.config.multi_account.account_index_key,
                enabled: false,
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
                enabled: false,
                content: this._buildManagedTradeCommandGuide(states),
            },
            {
                name: this.config.multi_account.role_output_rules_key,
                enabled: false,
                content: this._buildRoleOutputRules(),
            },
            {
                name: this.config.world_book_keys.kline_context,
                enabled: false,
                content: JSON.stringify(klineContext, null, 2),
            },
            {
                name: this.config.multi_account.auto_event_log_key,
                enabled: false,
                content: JSON.stringify(this._defaultAutoEventLog(), null, 2),
            },
        );
        return entries;
    }

    async syncManagedAccountsWorldbook() {
        const controlName = this.config.multi_account.control_worldbook_name;
        const states = await this.getManagedAccountStates();

        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries(states));
        await this._ensureAdditionalWorldbook(controlName);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, this.config.multi_account.command_entry_key, this._buildManagedTradeCommandGuide(states), false);
            this._upsertWorldbookEntry(entries, this.config.multi_account.role_output_rules_key, this._buildRoleOutputRules(), false);
            const klineContext = this.getState(this.config.world_book_keys.kline_context) || this.config.default_game_state.kline_context;
            this._upsertWorldbookEntry(entries, this.config.world_book_keys.kline_context, JSON.stringify(klineContext, null, 2), false);
            const eventLogEntry = entries.find(entry => entry.name === this.config.multi_account.auto_event_log_key);
            if (!eventLogEntry) {
                this._upsertWorldbookEntry(entries, this.config.multi_account.auto_event_log_key, JSON.stringify(this._defaultAutoEventLog(), null, 2), false);
            } else {
                eventLogEntry.enabled = false;
            }
            const accountIndex = entries.find(entry => entry.name === this.config.multi_account.account_index_key);
            if (accountIndex) accountIndex.enabled = false;
            for (const entry of entries) {
                if (entry.name?.startsWith(`${this.config.multi_account.account_state_key}_`)) {
                    entry.enabled = false;
                }
                if (entry.name?.startsWith(`${this.config.multi_account.role_profile_prefix}_`)) {
                    entry.enabled = false;
                }
            }
            return entries.filter(entry =>
                entry.name !== this.config.multi_account.recent_news_key &&
                !DEPRECATED_MANAGED_ACCOUNT_ENTRIES.has(entry.name)
            );
        });
    }

    async cleanupRedundantKlineContextEntries() {
        const klineKey = this.config.world_book_keys.kline_context;
        const controlName = this.config.multi_account.control_worldbook_name;
        let allBooks = [];
        try {
            allBooks = await this.th.getWorldbookNames();
        } catch (error) {
            this.logger.warn('读取世界书列表失败，无法清理重复 K 线上下文。', error);
            return [];
        }

        const targets = [...new Set(this.config.market_context_worldbooks || [])]
            .filter(name => name !== controlName && allBooks.includes(name));
        const cleaned = [];
        for (const worldbookName of targets) {
            let removed = false;
            await this.th.updateWorldbookWith(worldbookName, entries => {
                removed = entries.some(entry => entry.name === klineKey);
                return removed ? entries.filter(entry => entry.name !== klineKey) : entries;
            });
            if (removed) cleaned.push(worldbookName);
        }
        return cleaned;
    }

    _collectManagedObservationScope(commands = []) {
        const accountIds = new Set();
        let marketRequested = false;
        const rejected = [];

        for (const command of commands) {
            if (command?.module !== 'Observe') continue;
            if (command.type === 'Market') {
                marketRequested = true;
                continue;
            }
            if (command.type === 'Account' || command.type === 'Combined') {
                const accountId = command.args?.[0];
                if (typeof accountId === 'string' && accountId.trim()) {
                    accountIds.add(accountId.trim());
                } else {
                    rejected.push(`${command.type}: 缺少 account_id`);
                }
                continue;
            }
            rejected.push(`${command.type || 'Unknown'}: 不支持的观察指令`);
        }

        return { accountIds: [...accountIds], marketRequested, rejected };
    }

    async beginManagedObservationSession(commands = []) {
        if (this.activeManagedObservationSession) {
            await this.endManagedObservationSession(this.activeManagedObservationSession.id, { markObserved: false });
        }

        await this.syncManagedAccountsWorldbook();
        const scope = this._collectManagedObservationScope(commands);
        const states = await this.getManagedAccountStates();
        const stateById = new Map(states.map(state => [state.account_id, state]));
        const validAccountIds = scope.accountIds.filter(accountId => stateById.has(accountId));
        const unknownAccountIds = scope.accountIds.filter(accountId => !stateById.has(accountId));
        const marketRequested = scope.marketRequested || validAccountIds.length > 0;
        const activatedEntryNames = [];
        const contextEntries = [];
        const observedEventIds = {};
        const controlName = this.config.multi_account.control_worldbook_name;

        if (!marketRequested && validAccountIds.length === 0) {
            return {
                active: false,
                reason: '没有有效的 Observe 指令。',
                requested_account_ids: scope.accountIds,
                unknown_account_ids: unknownAccountIds,
                rejected: scope.rejected,
                activated_entries: [],
                context: '',
            };
        }

        await this.th.updateWorldbookWith(controlName, entries => {
            const enableEntry = entry => {
                if (!entry) return;
                entry.enabled = true;
                activatedEntryNames.push(entry.name);
                contextEntries.push(`### ${entry.name}\n${entry.content || ''}`);
            };

            if (marketRequested) {
                enableEntry(entries.find(entry => entry.name === this.config.world_book_keys.kline_context));
            }
            for (const accountId of validAccountIds) {
                const entryName = this._getManagedAccountStateEntryName(accountId);
                const entry = entries.find(item => item.name === entryName);
                enableEntry(entry);
                const state = stateById.get(accountId);
                observedEventIds[accountId] = (state?.recent_major_events || [])
                    .filter(event => !event.observed)
                    .map(event => event.id);
            }
            return entries;
        });

        const session = {
            id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            active: true,
            created_at: Date.now(),
            requested_account_ids: scope.accountIds,
            account_ids: validAccountIds,
            unknown_account_ids: unknownAccountIds,
            market_requested: marketRequested,
            rejected: scope.rejected,
            activated_entries: activatedEntryNames,
            observed_event_ids: observedEventIds,
            context: contextEntries.join('\n\n'),
        };
        this.activeManagedObservationSession = session;
        return { ...session };
    }

    async endManagedObservationSession(sessionId = null, options = {}) {
        const session = this.activeManagedObservationSession;
        if (!session || (sessionId && session.id !== sessionId)) return false;
        const markObserved = options.markObserved !== false;
        const controlName = this.config.multi_account.control_worldbook_name;
        const now = Date.now();

        await this.th.updateWorldbookWith(controlName, entries => {
            const activated = new Set(session.activated_entries || []);
            for (const entry of entries) {
                if (activated.has(entry.name)) entry.enabled = false;
                if (!markObserved || !entry.name?.startsWith(`${this.config.multi_account.account_state_key}_`)) continue;
                const accountId = entry.name.slice(`${this.config.multi_account.account_state_key}_`.length);
                const eventIds = new Set(session.observed_event_ids?.[accountId] || []);
                if (eventIds.size === 0) continue;
                try {
                    const state = JSON.parse(entry.content || '{}');
                    state.recent_major_events = (state.recent_major_events || []).map(event => (
                        eventIds.has(event.id) ? { ...event, observed: true, observed_at: now } : event
                    ));
                    entry.content = JSON.stringify(state, null, 2);
                } catch (error) {
                    this.logger.warn(`标记账户重大事件为已观察失败: ${entry.name}`, error);
                }
            }
            return entries;
        });

        this.activeManagedObservationSession = null;
        return true;
    }

    async getManagedObservationDebugState() {
        const controlName = this.config.multi_account.control_worldbook_name;
        let entries = [];
        try {
            entries = await this.th.getWorldbook(controlName);
        } catch (error) {
            return { session: this.activeManagedObservationSession, entries: [], error: error?.message || String(error) };
        }
        const relevantNames = new Set([
            this.config.multi_account.command_entry_key,
            this.config.multi_account.role_output_rules_key,
            this.config.world_book_keys.kline_context,
        ]);
        return {
            session: this.activeManagedObservationSession,
            entries: entries
                .filter(entry =>
                    relevantNames.has(entry.name) ||
                    entry.name?.startsWith(`${this.config.multi_account.account_state_key}_`) ||
                    entry.name?.startsWith(`${this.config.multi_account.role_profile_prefix}_`)
                )
                .map(entry => ({ name: entry.name, enabled: Boolean(entry.enabled), content_length: String(entry.content || '').length })),
        };
    }

    _defaultAutoEventLog() {
        return {
            comment: 'SillyView 自动推进重要事件日志。仅记录时间点、事件类型、资产和简短内容，不记录账户余额或盈亏。',
            updated_at: 0,
            events: [],
        };
    }

    async appendAutoEventLog(event = {}) {
        const controlName = this.config.multi_account.control_worldbook_name;
        const entryName = this.config.multi_account.auto_event_log_key;
        const normalized = {
            time_index: Number(event.time_index || 0),
            minute_time_index: Number(event.minute_time_index || 0),
            datetime: String(event.datetime || ''),
            type: String(event.type || 'important_event'),
            asset_code: String(event.asset_code || 'GLOBAL'),
            content: String(event.content || '').slice(0, 240),
        };

        await this._ensureWorldbookExists(controlName, [{
            name: entryName,
            enabled: false,
            content: JSON.stringify(this._defaultAutoEventLog(), null, 2),
        }]);
        await this.th.updateWorldbookWith(controlName, entries => {
            const entry = entries.find(item => item.name === entryName) || this._upsertWorldbookEntry(
                entries,
                entryName,
                JSON.stringify(this._defaultAutoEventLog(), null, 2),
                false
            );
            let state;
            try {
                state = JSON.parse(entry.content || '{}');
            } catch (error) {
                state = this._defaultAutoEventLog();
            }
            const events = Array.isArray(state.events) ? state.events : [];
            events.push({ id: Date.now(), ...normalized });
            state.comment = this._defaultAutoEventLog().comment;
            state.updated_at = normalized.time_index;
            state.events = events.slice(-100);
            entry.content = JSON.stringify(state, null, 2);
            entry.enabled = false;
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
        await this._ensureWorldbookExists(controlName, this._buildManagedControlEntries(states, accountEntries));
        await this._ensureAdditionalWorldbook(controlName);
        await this.th.updateWorldbookWith(controlName, entries => {
            this._upsertWorldbookEntry(entries, this.config.multi_account.account_index_key, JSON.stringify({
                comment: 'SillyView 多账户索引。账号完整状态保存在本世界书内各自的 sv_account_state_* 词条中。',
                updated_at: Date.now(),
                accounts: accountEntries,
            }, null, 2), false);
            return entries.filter(entry => !DEPRECATED_MANAGED_ACCOUNT_ENTRIES.has(entry.name));
        });
        await this.syncManagedAccountsWorldbook();
        const roleProfiles = await this.syncBoundRoleProfiles();
        await this.cleanupRedundantKlineContextEntries();
        await this.cleanupLegacyManagedAccountWorldbooks();
        this.logger.success(`已同步 ${accountEntries.length} 个开户行账户到 ${controlName}。`);
        this.logger.success(`已同步 ${roleProfiles.length} 个角色人设到 ${controlName}。`);
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
            const excludedEntryNames = new Set([
                this.config.world_book_keys.config,
                this.config.world_book_keys.global_market,
                this.config.world_book_keys.dialogue_context,
                this.config.world_book_keys.player_portfolio,
                this.config.world_book_keys.ai_context,
                this.config.world_book_keys.kline_context,
                this.config.world_book_keys.market_overview,
                this.config.world_book_keys.market_targets,
                this.config.world_book_keys.news_archive,
                this.config.world_book_keys.active_market_news,
                this.config.multi_account.account_index_key,
            ]);
            for (const worldbookName of namesToRead) {
                const entries = await this.th.getWorldbook(worldbookName);
                const sourceEntries = entries.filter(entry => {
                    const entryName = String(entry.name || '');
                    return entry.enabled &&
                        entry.content?.trim() &&
                        !excludedEntryNames.has(entryName) &&
                        !entryName.startsWith(this.config.world_book_keys.asset_prefix) &&
                        !entryName.startsWith(`${this.config.multi_account.account_state_key}_`);
                });

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
        const isBuySide = ['spot_buy', 'open_long', 'add_long', 'close_short'].includes(intent);
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
            trailing_stop_pct: (() => {
                const number = Number(riskControls.trailing_stop_pct);
                return Number.isFinite(number) && number > 0 && number <= 50 ? number : null;
            })(),
        };
    }

    _areRiskControlsValidForPosition(position, riskControls, marketPrice = null) {
        if (!position?.type || !riskControls) return false;
        const referencePrice = Number(marketPrice ?? position.avgEntryPrice ?? 0);
        if (!Number.isFinite(referencePrice) || referencePrice <= 0) return false;
        const takeProfit = riskControls.take_profit;
        const stopLoss = riskControls.stop_loss;
        const trailingStopPct = riskControls.trailing_stop_pct;

        if (position.type === 'long') {
            if (takeProfit !== null && takeProfit <= referencePrice) return false;
            if (stopLoss !== null && stopLoss >= referencePrice) return false;
        } else {
            if (takeProfit !== null && takeProfit >= referencePrice) return false;
            if (stopLoss !== null && stopLoss <= referencePrice) return false;
        }
        if (trailingStopPct !== null && (!Number.isFinite(trailingStopPct) || trailingStopPct <= 0 || trailingStopPct > 50)) return false;
        return true;
    }

    _applyRiskControls(portfolio, assetCode, riskControls, mode = 'leveraged', referencePrice = null) {
        const normalized = this._normalizeRiskControls(riskControls);
        if (!normalized || (normalized.take_profit === null && normalized.stop_loss === null && normalized.trailing_stop_pct === null)) return '';
        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        const marketPrice = Number(referencePrice)
            || this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`)?.current_price;
        if (!this._areRiskControlsValidForPosition(position, normalized, marketPrice)) {
            this.logger.warn(`已忽略方向错误的止盈止损: ${assetCode}`);
            return '';
        }

        const asset = this._ensurePortfolioAssetBuckets(portfolio, assetCode);
        const bucket = asset[mode];
        const current = bucket.risk_controls || {};
        const existingAnchor = Number(current.trailing_anchor);
        let trailingAnchor = current.trailing_anchor ?? null;
        if (normalized.trailing_stop_pct !== null) {
            const nextAnchor = Number(marketPrice || position.avgEntryPrice);
            if (normalized.trailing_stop_pct === current.trailing_stop_pct && Number.isFinite(existingAnchor)) {
                trailingAnchor = position.type === 'short'
                    ? Math.min(existingAnchor, nextAnchor)
                    : Math.max(existingAnchor, nextAnchor);
            } else {
                trailingAnchor = nextAnchor;
            }
        }
        bucket.risk_controls = {
            take_profit: normalized.take_profit ?? current.take_profit ?? null,
            stop_loss: normalized.stop_loss ?? current.stop_loss ?? null,
            trailing_stop_pct: normalized.trailing_stop_pct ?? current.trailing_stop_pct ?? null,
            trailing_anchor: trailingAnchor,
        };

        const labels = [];
        if (normalized.take_profit !== null) labels.push(`止盈 ${normalized.take_profit.toFixed(4)}`);
        if (normalized.stop_loss !== null) labels.push(`止损 ${normalized.stop_loss.toFixed(4)}`);
        if (normalized.trailing_stop_pct !== null) labels.push(`移动止损 ${normalized.trailing_stop_pct.toFixed(2)}%`);
        return labels.length > 0 ? ` (${labels.join(' / ')})` : '';
    }

    async updatePositionRiskControls(assetCode, riskControls, mode = 'leveraged') {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const normalized = this._normalizeRiskControls(riskControls) || { take_profit: null, stop_loss: null };
        const currentPortfolio = this.getState(portfolioKey);
        const currentPosition = this.positionCalculator.calculate(assetCode, currentPortfolio, mode);
        const marketPrice = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`)?.current_price;
        if (!this._areRiskControlsValidForPosition(currentPosition, normalized, marketPrice)) return null;

        let updated = false;
        await this.updateState(portfolioKey, portfolio => {
            const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
            if (!position.type || position.totalAmount <= 0) return portfolio;

            const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[mode];

            if (normalized.take_profit === null && normalized.stop_loss === null && normalized.trailing_stop_pct === null) {
                delete bucket.risk_controls;
            } else {
                const current = bucket.risk_controls || {};
                bucket.risk_controls = {
                    ...normalized,
                    trailing_anchor: normalized.trailing_stop_pct === null
                        ? null
                        : (normalized.trailing_stop_pct === current.trailing_stop_pct
                            ? current.trailing_anchor
                            : Number(marketPrice || position.avgEntryPrice)),
                };
            }

            const labels = [];
            labels.push(normalized.take_profit === null ? '止盈 未设置' : `止盈 ${normalized.take_profit.toFixed(4)}`);
            labels.push(normalized.stop_loss === null ? '止损 未设置' : `止损 ${normalized.stop_loss.toFixed(4)}`);
            labels.push(normalized.trailing_stop_pct === null ? '移动止损 未设置' : `移动止损 ${normalized.trailing_stop_pct.toFixed(2)}%`);
            if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
            portfolio.actions_this_turn.push({
                id: Date.now(),
                text: `调整 ${assetCode} ${labels.join(' / ')}`,
                executedAt: null,
                intent: 'adjust_risk_controls',
                mode,
                assetCode,
                riskControls: normalized,
            });

            updated = true;
            return portfolio;
        });

        return updated ? normalized : null;
    }

    _getPendingOrderSide(intent) {
        if (['spot_buy', 'open_long', 'add_long', 'close_short'].includes(intent)) return 'buy';
        if (['spot_sell', 'open_short', 'add_short', 'close_long'].includes(intent)) return 'sell';
        return null;
    }

    _getPendingOrderCondition(orderType, side) {
        if (orderType === 'limit') return side === 'buy' ? 'below' : 'above';
        if (orderType === 'stop') return side === 'buy' ? 'above' : 'below';
        return null;
    }

    _createPendingOrderDraft(spec, portfolio) {
        const assetCode = String(spec?.assetCode || '');
        const intent = String(spec?.intent || '');
        const orderType = spec?.orderType === 'stop' ? 'stop' : (spec?.orderType === 'limit' ? 'limit' : '');
        const mode = spec?.mode === 'spot' ? 'spot' : 'leveraged';
        const side = this._getPendingOrderSide(intent);
        const triggerPrice = Number(spec?.triggerPrice);
        const amount = Number(spec?.amount);
        const leverage = mode === 'spot' ? 1 : Math.max(1, Number(spec?.leverage) || 1);
        const currentPrice = Number(this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`)?.current_price || 0);
        const condition = this._getPendingOrderCondition(orderType, side);

        if (!this.config.asset_definitions[assetCode]) return { error: '不支持该交易品种。' };
        if (!side || !condition) return { error: '挂单方向或类型无效。' };
        if (!Number.isFinite(triggerPrice) || triggerPrice <= 0 || !currentPrice) return { error: '请输入有效的触发价。' };
        if (condition === 'below' ? triggerPrice >= currentPrice : triggerPrice <= currentPrice) {
            const direction = condition === 'below' ? '低于' : '高于';
            return { error: `${orderType === 'limit' ? '限价单' : '条件单'}触发价必须${direction}当前价。` };
        }

        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        const needsAmount = !intent.startsWith('close') && intent !== 'spot_sell';
        if (needsAmount && (!Number.isFinite(amount) || amount <= 0)) return { error: '请输入有效的交易金额。' };
        if ((intent === 'close_long' && position.type !== 'long')
            || (intent === 'close_short' && position.type !== 'short')
            || (intent === 'spot_sell' && position.type !== 'long')) {
            return { error: '当前持仓与挂单平仓方向不匹配。' };
        }

        const riskControls = this._normalizeRiskControls(spec?.riskControls);
        const targetType = side === 'buy' ? 'long' : 'short';
        if (riskControls && !this._areRiskControlsValidForPosition({ type: targetType }, riskControls, triggerPrice)) {
            return { error: '止盈止损方向必须以挂单触发价为基准。' };
        }

        const market = this.getState(this.config.world_book_keys.global_market) || {};
        return {
            order: {
                id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                asset_code: assetCode,
                order_type: orderType,
                side,
                intent,
                mode,
                amount: needsAmount ? amount : Number(position.totalAmount || 0),
                leverage,
                trigger_price: triggerPrice,
                risk_controls: riskControls,
                oco_group_id: spec?.ocoGroupId || null,
                status: 'pending',
                created_at: Date.now(),
                created_time_index: Number(market.current_time_index || 0),
                created_minute_index: Number(market.minute_time_index || 0),
            },
        };
    }

    getPendingOrders(assetCode = null) {
        const portfolio = this.getState(this.config.world_book_keys.player_portfolio) || {};
        const orders = Array.isArray(portfolio.pending_orders) ? portfolio.pending_orders : [];
        return assetCode ? orders.filter(order => order.asset_code === assetCode) : orders;
    }

    async placePendingOrder(spec) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this.getState(portfolioKey) || {};
        this._ensurePendingOrderShape(portfolio);
        if (portfolio.pending_orders.length >= 50) return { ok: false, error: '挂单数量已达到 50 张上限。' };
        const draft = this._createPendingOrderDraft(spec, portfolio);
        if (!draft.order) return { ok: false, error: draft.error };

        await this.updateState(portfolioKey, state => {
            this._ensurePendingOrderShape(state);
            state.pending_orders.push(draft.order);
            state.actions_this_turn = state.actions_this_turn || [];
            state.actions_this_turn.push({
                id: Date.now(),
                text: `挂出 ${draft.order.asset_code} ${draft.order.order_type === 'limit' ? '限价' : '条件'}${draft.order.side === 'buy' ? '买单' : '卖单'}`,
                executedAt: draft.order.trigger_price,
                intent: 'place_pending_order',
                assetCode: draft.order.asset_code,
                orderId: draft.order.id,
            });
            return state;
        });
        return { ok: true, orders: [draft.order] };
    }

    async placeOcoOrders(specs) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this.getState(portfolioKey) || {};
        this._ensurePendingOrderShape(portfolio);
        if (!Array.isArray(specs) || specs.length !== 2) return { ok: false, error: 'OCO 必须包含两张挂单。' };
        if (portfolio.pending_orders.length > 48) return { ok: false, error: '挂单数量不足以创建 OCO。' };
        const groupId = `oco_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const drafts = specs.map(spec => this._createPendingOrderDraft({ ...spec, ocoGroupId: groupId }, portfolio));
        const invalid = drafts.find(draft => !draft.order);
        if (invalid) return { ok: false, error: invalid.error };

        const orders = drafts.map(draft => draft.order);
        await this.updateState(portfolioKey, state => {
            this._ensurePendingOrderShape(state);
            state.pending_orders.push(...orders);
            state.actions_this_turn = state.actions_this_turn || [];
            state.actions_this_turn.push({
                id: Date.now(),
                text: `挂出 ${orders[0].asset_code} OCO ${orders[0].side === 'buy' ? '买单' : '卖单'}`,
                executedAt: null,
                intent: 'place_oco_order',
                assetCode: orders[0].asset_code,
                orderIds: orders.map(order => order.id),
            });
            return state;
        });
        return { ok: true, orders };
    }

    _archivePendingOrder(portfolio, order, status, details = {}) {
        this._ensurePendingOrderShape(portfolio);
        portfolio.order_history.unshift({
            ...order,
            ...details,
            status,
            completed_at: Date.now(),
        });
        if (portfolio.order_history.length > 50) portfolio.order_history.length = 50;
    }

    async cancelPendingOrder(orderId, reason = 'user_cancelled') {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        let cancelled = null;
        await this.updateState(portfolioKey, portfolio => {
            this._ensurePendingOrderShape(portfolio);
            const index = portfolio.pending_orders.findIndex(order => order.id === orderId);
            if (index < 0) return portfolio;
            cancelled = portfolio.pending_orders.splice(index, 1)[0];
            this._archivePendingOrder(portfolio, cancelled, 'cancelled', { cancel_reason: reason });
            return portfolio;
        });
        return cancelled;
    }

    _getPendingOrderExecutionPrice(order, candle) {
        const open = Number(candle?.open);
        const trigger = Number(order.trigger_price);
        const condition = this._getPendingOrderCondition(order.order_type, order.side);
        if (Number.isFinite(open) && (condition === 'above' ? open >= trigger : open <= trigger)) return open;
        return trigger;
    }

    async triggerPendingOrdersForCandle(assetCode, candle) {
        if (!candle) return [];
        const events = [];
        for (let attempt = 0; attempt < 50; attempt++) {
            const orders = this.getPendingOrders(assetCode);
            const candidates = orders.map(order => ({
                ...order,
                type: 'pending_order',
                price: Number(order.trigger_price),
                condition: this._getPendingOrderCondition(order.order_type, order.side),
            })).filter(candidate => candidate.condition);
            const triggered = this._selectFirstCandleTrigger(candle, candidates);
            if (!triggered) break;

            const order = orders.find(item => item.id === triggered.id);
            if (!order) break;
            await this.updateState(this.config.world_book_keys.player_portfolio, portfolio => {
                this._ensurePendingOrderShape(portfolio);
                portfolio.pending_orders = portfolio.pending_orders.filter(item => item.id !== order.id);
                return portfolio;
            });

            const rawExecutionPrice = this._getPendingOrderExecutionPrice(order, candle);
            const success = await this.executeAndRecordTrade(
                order.intent,
                order.amount,
                order.asset_code,
                rawExecutionPrice,
                order.leverage,
                order.risk_controls,
                order.mode,
                order.order_type === 'limit' ? { limitPrice: order.trigger_price } : null,
            );
            const executedPortfolio = this.getState(this.config.world_book_keys.player_portfolio) || {};
            const executedAction = success
                ? [...(executedPortfolio.actions_this_turn || [])].reverse().find(action =>
                    action.assetCode === order.asset_code && action.intent === order.intent && Number.isFinite(action.executedAt)
                )
                : null;
            const actualExecutionPrice = Number(executedAction?.executedAt || rawExecutionPrice);

            const cancelledSiblings = [];
            await this.updateState(this.config.world_book_keys.player_portfolio, portfolio => {
                this._ensurePendingOrderShape(portfolio);
                this._archivePendingOrder(portfolio, order, success ? 'filled' : 'rejected', {
                    filled_at: success ? Date.now() : null,
                    filled_price: success ? actualExecutionPrice : null,
                    reject_reason: success ? null : 'execution_failed',
                });
                if (success && order.oco_group_id) {
                    portfolio.pending_orders = portfolio.pending_orders.filter(item => {
                        if (item.oco_group_id !== order.oco_group_id) return true;
                        cancelledSiblings.push(item);
                        this._archivePendingOrder(portfolio, item, 'cancelled', { cancel_reason: 'oco_peer_filled' });
                        return false;
                    });
                }
                return portfolio;
            });

            events.push({ order, success, price: actualExecutionPrice, cancelledSiblings });
            if (success) {
                this.dependencies.win.toastr.success(`${assetCode} 挂单已触发成交 @ ${actualExecutionPrice.toFixed(5)}。`, '挂单成交');
            } else {
                this.dependencies.win.toastr.warning(`${assetCode} 挂单已触发，但交易校验未通过。`, '挂单失败');
            }
        }
        return events;
    }

    async executeAndRecordTrade(intent, amount, assetCode, executionPrice = null, leverage = 1, riskControls = null, mode = 'leveraged', executionOptions = null) {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const assetDataKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        let portfolio = this._stateCache.get(portfolioKey);
        let assetData = this._stateCache.get(assetDataKey);
        if (!portfolio || !assetData) return false;

        // **FIX**: Ensure portfolio.assets exists to prevent crashes on old save data.
        if (!portfolio.assets) {
            portfolio.assets = {};
        }

        const normalizedMode = mode === 'spot' ? 'spot' : 'leveraged';
        const normalizedLeverage = normalizedMode === 'spot' ? 1 : Math.max(1, Number(leverage) || 1);
        this._ensureAssetDataShape(assetData);
        const lastMinuteCandle = assetData.kline_minute.slice(-1)[0];
        const lastCandle = lastMinuteCandle || assetData.kline_hourly.slice(-1)[0];
        const rawPrice = executionPrice !== null ? executionPrice : (assetData.current_price ?? lastCandle.close);
        let price = this._calculateExecutionPrice(assetCode, intent, rawPrice);
        const limitPrice = Number(executionOptions?.limitPrice);
        if (Number.isFinite(limitPrice) && limitPrice > 0) {
            price = this._getPendingOrderSide(intent) === 'buy'
                ? Math.min(price, limitPrice)
                : Math.max(price, limitPrice);
        }
        const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[normalizedMode];
        const position = this.positionCalculator.calculate(assetCode, portfolio, normalizedMode);
        const tradeConfig = this._getTradeConfig(assetCode);
        const totalPositionValue = intent === 'spot_sell'
            ? position.totalShares * price
            : intent.startsWith('close')
                ? position.positionValue
            : amount * normalizedLeverage;
        const fee = totalPositionValue * (tradeConfig.fee_rate ?? 0.001);
        let actionText = '';
        
        portfolio.cash = portfolio.cash || 0;

        switch (intent) {
            case 'spot_buy':
                if (portfolio.cash < amount + fee) { this.dependencies.win.toastr.warning("交易失败：现金不足以支付现货金额和手续费。"); return false; }
                portfolio.cash -= (amount + fee);
                bucket.trades.push({ time: lastCandle.time, price, amount, type: 'long', leverage: 1 });
                actionText = position.type ? `加仓现货 ${assetCode}` : `买入现货 ${assetCode}`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls, 'spot', price);
                this._recordTradeTransaction(portfolio, actionText, -amount);
                this._recordTradeTransaction(portfolio, '交易手续费', -fee);
                break;

            case 'spot_sell':
                if (position.type !== 'long') { this.dependencies.win.toastr.warning("交易失败：没有现货可以卖出。"); return false; }
                const spotPnl = (price - position.avgEntryPrice) * position.totalShares;
                portfolio.cash += position.totalAmount + spotPnl - fee;
                this._recordTradeTransaction(portfolio, `卖出现货 ${assetCode}`, position.totalAmount + spotPnl);
                this._recordTradeTransaction(portfolio, '交易手续费', -fee);
                this._recordTradeTransaction(portfolio, `已实现盈亏 (${assetCode} 现货)`, spotPnl);
                bucket.trades = [];
                delete bucket.risk_controls;
                actionText = `卖出现货 ${assetCode}`;
                break;

            case 'open_long':
                if (position.type !== null) { this.dependencies.win.toastr.warning("已有持仓，无法开新仓。请先平仓或加仓。"); return false; }
                // Fallthrough to add_long logic
            case 'add_long':
                if (position.type === 'short') { this.dependencies.win.toastr.warning("无法做多：当前持有空头仓位。"); return false; }
                if (portfolio.cash < amount + fee) { this.dependencies.win.toastr.warning("交易失败：现金不足以支付保证金和手续费。"); return false; }
                
                portfolio.cash -= (amount + fee);
                bucket.trades.push({ time: lastCandle.time, price, amount, type: 'long', leverage: normalizedLeverage });
                const longRiskText = this._applyRiskControls(portfolio, assetCode, riskControls, 'leveraged', price);
                
                actionText = (intent === 'open_long') 
                    ? `开多 (${normalizedLeverage}x) ${assetCode}`
                    : `加仓多 (${normalizedLeverage}x) ${assetCode}`;
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
                bucket.trades.push({ time: lastCandle.time, price, amount, type: 'short', leverage: normalizedLeverage });
                const shortRiskText = this._applyRiskControls(portfolio, assetCode, riskControls, 'leveraged', price);
                
                actionText = (intent === 'open_short') 
                    ? `开空 (${normalizedLeverage}x) ${assetCode}`
                    : `加仓空 (${normalizedLeverage}x) ${assetCode}`;
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
                bucket.trades = [];
                delete bucket.risk_controls;
                actionText = `平多 ${assetCode}`;
                break;

            case 'close_short':
                if (position.type !== 'short') { this.dependencies.win.toastr.warning("交易失败：没有空头仓位可以平仓。"); return false; }
                const pnl_short = (position.avgEntryPrice - price) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl_short - fee;
                this._recordTradeTransaction(portfolio, `平空仓 ${assetCode}`, position.totalAmount + pnl_short);
                this._recordTradeTransaction(portfolio, `交易手续费`, -fee);
                this._recordTradeTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl_short);
                bucket.trades = [];
                delete bucket.risk_controls;
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
            leverage: normalizedLeverage,
            mode: normalizedMode,
            assetCode: assetCode,
        });

        this._stateCache.set(portfolioKey, portfolio);
        return true;
    }
    
    _selectFirstCandleTrigger(candle, candidates) {
        if (!candle || !Array.isArray(candidates) || candidates.length === 0) return null;
        const open = Number(candle.open ?? candle.close);
        const close = Number(candle.close ?? open);
        const high = Math.max(Number(candle.high ?? open), open, close);
        const low = Math.min(Number(candle.low ?? open), open, close);
        if (![open, close, high, low].every(Number.isFinite)) return null;

        const validCandidates = candidates.filter(candidate =>
            Number.isFinite(Number(candidate.price)) && Number(candidate.price) > 0
        );
        const immediate = validCandidates.filter(candidate =>
            candidate.condition === 'above'
                ? open >= candidate.price
                : open <= candidate.price
        );
        if (immediate.length > 0) {
            immediate.sort((a, b) => Math.abs(a.price - open) - Math.abs(b.price - open));
            return { ...immediate[0], executionPrice: open, pathPosition: 0 };
        }

        const path = close >= open ? [open, low, high, close] : [open, high, low, close];
        for (let index = 0; index < path.length - 1; index++) {
            const from = path[index];
            const to = path[index + 1];
            const segmentLow = Math.min(from, to);
            const segmentHigh = Math.max(from, to);
            const crossed = validCandidates.filter(candidate =>
                candidate.price >= segmentLow && candidate.price <= segmentHigh
            );
            if (crossed.length > 0) {
                crossed.sort((a, b) => Math.abs(a.price - from) - Math.abs(b.price - from));
                const distance = Math.abs(to - from);
                const fraction = distance > 0 ? Math.abs(crossed[0].price - from) / distance : 0;
                return { ...crossed[0], pathPosition: index + fraction };
            }
        }
        return null;
    }

    _evaluateTrailingStop(candle, position, controls = {}) {
        const trailingPct = Number(controls.trailing_stop_pct);
        if (!position?.type || !Number.isFinite(trailingPct) || trailingPct <= 0 || trailingPct > 50) return null;
        const open = Number(candle?.open ?? candle?.close);
        const close = Number(candle?.close ?? open);
        const high = Math.max(Number(candle?.high ?? open), open, close);
        const low = Math.min(Number(candle?.low ?? open), open, close);
        if (![open, close, high, low].every(Number.isFinite)) return null;

        const distanceRatio = trailingPct / 100;
        let anchor = Number(controls.trailing_anchor || position.avgEntryPrice || open);
        if (!Number.isFinite(anchor) || anchor <= 0) anchor = open;
        const path = close >= open ? [open, low, high, close] : [open, high, low, close];
        for (let index = 0; index < path.length - 1; index++) {
            const from = path[index];
            const to = path[index + 1];
            if (position.type === 'long') {
                anchor = Math.max(anchor, from);
                const stopPrice = anchor * (1 - distanceRatio);
                if (from <= stopPrice) return { triggered: true, price: from, anchor, pathPosition: index };
                if (to >= from) {
                    anchor = Math.max(anchor, to);
                } else if (to <= stopPrice) {
                    const fraction = Math.abs(stopPrice - from) / Math.max(Math.abs(to - from), Number.EPSILON);
                    return { triggered: true, price: stopPrice, anchor, pathPosition: index + fraction };
                }
            } else {
                anchor = Math.min(anchor, from);
                const stopPrice = anchor * (1 + distanceRatio);
                if (from >= stopPrice) return { triggered: true, price: from, anchor, pathPosition: index };
                if (to <= from) {
                    anchor = Math.min(anchor, to);
                } else if (to >= stopPrice) {
                    const fraction = Math.abs(stopPrice - from) / Math.max(Math.abs(to - from), Number.EPSILON);
                    return { triggered: true, price: stopPrice, anchor, pathPosition: index + fraction };
                }
            }
        }
        return { triggered: false, anchor };
    }

    async _updateTrailingAnchor(assetCode, mode, anchor) {
        if (!Number.isFinite(anchor) || anchor <= 0) return;
        await this.updateState(this.config.world_book_keys.player_portfolio, portfolio => {
            const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[mode];
            if (bucket.risk_controls?.trailing_stop_pct) bucket.risk_controls.trailing_anchor = anchor;
            return portfolio;
        });
    }

    async liquidatePosition(assetCode, liquidationPrice, triggerCandle = null) {
        this.dependencies.win.toastr.error(`${assetCode} 仓位已被强制平仓！`, "爆仓！");
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const portfolio = this.getState(portfolioKey);
        const position = this.positionCalculator.calculate(assetCode, portfolio, 'leveraged');
        if (!position.type || position.totalAmount <= 0) return null;

        const tradeConfig = this._getTradeConfig(assetCode);
        const fee = position.positionValue * (tradeConfig.fee_rate ?? 0.001);
        const realizedPnl = position.type === 'long'
            ? (liquidationPrice - position.avgEntryPrice) * position.totalShares
            : (position.avgEntryPrice - liquidationPrice) * position.totalShares;
        const remainingEquity = Math.max(0, position.totalAmount + realizedPnl - fee);
        const market = this.getState(this.config.world_book_keys.global_market);
        await this.updateState(portfolioKey, state => {
            const bucket = this._ensurePortfolioAssetBuckets(state, assetCode).leveraged;
            bucket.trades = [];
            delete bucket.risk_controls;
            state.cash = Number(state.cash || 0) + remainingEquity;
            if (!Array.isArray(state.transaction_log)) state.transaction_log = [];
            state.transaction_log.unshift({
                time: market?.current_time_index || 0,
                description: `爆仓强平 (${assetCode})`,
                amount: remainingEquity,
            });
            state.transaction_log.unshift({ time: market?.current_time_index || 0, description: '交易手续费', amount: -fee });
            state.transaction_log.unshift({ time: market?.current_time_index || 0, description: `已实现盈亏 (${assetCode})`, amount: realizedPnl });
            if (state.transaction_log.length > 100) state.transaction_log.length = 100;
            return state;
        });
        return {
            triggered: true,
            triggerType: 'liquidation',
            price: liquidationPrice,
            pnl: realizedPnl,
            fee,
            triggerCandle,
        };
    }

    async closePositionAtPrice(assetCode, closePrice, reason = 'risk_control', triggerCandle = null, mode = 'leveraged') {
        const portfolioKey = this.config.world_book_keys.player_portfolio;
        const market = this.getState(this.config.world_book_keys.global_market);
        const portfolio = this.getState(portfolioKey);
        if (!portfolio) return null;

        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        if (!position.type || position.totalAmount <= 0) return null;

        const tradeConfig = this._getTradeConfig(assetCode);
        const feeBase = mode === 'spot' ? position.totalShares * closePrice : position.positionValue;
        const fee = feeBase * (tradeConfig.fee_rate ?? 0.001);
        const realizedPnl = position.type === 'long'
            ? (closePrice - position.avgEntryPrice) * position.totalShares
            : (position.avgEntryPrice - closePrice) * position.totalShares;
        const closeAmount = position.totalAmount + realizedPnl - fee;
        const label = reason === 'take_profit' ? '止盈' : (reason === 'trailing_stop' ? '移动止损' : '止损');

        await this.updateState(portfolioKey, p => {
            const bucket = this._ensurePortfolioAssetBuckets(p, assetCode)[mode];
            p.cash = (p.cash || 0) + closeAmount;
            bucket.trades = [];
            delete bucket.risk_controls;
            if (!p.transaction_log) p.transaction_log = [];
            const time = market ? market.current_time_index : 0;
            p.transaction_log.unshift({ time, description: `${label}平仓 ${assetCode} ${mode === 'spot' ? '现货' : '杠杆'}`, amount: closeAmount });
            p.transaction_log.unshift({ time, description: `交易手续费`, amount: -fee });
            p.transaction_log.unshift({ time, description: `已实现盈亏 (${assetCode})`, amount: realizedPnl });
            if (p.transaction_log.length > 100) p.transaction_log.length = 100;
            return p;
        });

        this.dependencies.win.toastr.success(`${assetCode} ${label}触发，已按 ${closePrice.toFixed(4)} 平仓。`, label);
        return {
            triggered: true,
            triggerType: reason,
            mode,
            price: closePrice,
            pnl: realizedPnl,
            fee,
            triggerCandle: triggerCandle ? {
                time: triggerCandle.time,
                open: Number(triggerCandle.open),
                high: Number(triggerCandle.high),
                low: Number(triggerCandle.low),
                close: Number(triggerCandle.close),
            } : null,
        };
    }

    async triggerRiskControlsForCandle(assetCode, candle, options = {}) {
        if (!candle) return null;

        const portfolio = this.getState(this.config.world_book_keys.player_portfolio);
        const events = [];
        const skipModes = new Set(options.skipModes || []);
        for (const mode of ['leveraged', 'spot']) {
            if (skipModes.has(mode)) continue;
            const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
            if (!position.type || position.totalAmount <= 0) continue;

            const riskControls = portfolio?.assets?.[assetCode]?.[mode]?.risk_controls || {};
            const takeProfit = Number(riskControls.take_profit);
            const stopLoss = Number(riskControls.stop_loss);
            const candidates = [];
            if (position.type === 'long') {
                if (Number.isFinite(takeProfit) && takeProfit > 0) candidates.push({ type: 'take_profit', price: takeProfit, condition: 'above' });
                if (Number.isFinite(stopLoss) && stopLoss > 0) candidates.push({ type: 'stop_loss', price: stopLoss, condition: 'below' });
                if (mode === 'leveraged' && position.isLeveraged && position.liquidationPrice > 0) candidates.push({ type: 'liquidation', price: position.liquidationPrice, condition: 'below' });
            } else if (position.type === 'short') {
                if (Number.isFinite(takeProfit) && takeProfit > 0) candidates.push({ type: 'take_profit', price: takeProfit, condition: 'below' });
                if (Number.isFinite(stopLoss) && stopLoss > 0) candidates.push({ type: 'stop_loss', price: stopLoss, condition: 'above' });
                if (mode === 'leveraged' && position.isLeveraged && position.liquidationPrice > 0) candidates.push({ type: 'liquidation', price: position.liquidationPrice, condition: 'above' });
            }

            const fixedTrigger = this._selectFirstCandleTrigger(candle, candidates);
            const trailingResult = this._evaluateTrailingStop(candle, position, riskControls);
            const trailingTrigger = trailingResult?.triggered ? {
                type: 'trailing_stop',
                price: trailingResult.price,
                pathPosition: trailingResult.pathPosition,
            } : null;
            const firstTrigger = trailingTrigger && (!fixedTrigger || trailingTrigger.pathPosition < fixedTrigger.pathPosition)
                ? trailingTrigger
                : fixedTrigger;
            if (!firstTrigger && trailingResult && trailingResult.anchor !== Number(riskControls.trailing_anchor)) {
                await this._updateTrailingAnchor(assetCode, mode, trailingResult.anchor);
            }
            if (!firstTrigger) continue;
            const triggerPrice = Number(firstTrigger.executionPrice ?? firstTrigger.price);
            const result = firstTrigger.type === 'liquidation'
                ? await this.liquidatePosition(assetCode, triggerPrice, candle)
                : await this.closePositionAtPrice(assetCode, triggerPrice, firstTrigger.type, candle, mode);
            if (result?.triggered) events.push({ ...result, mode });
        }
        return events.length > 0 ? { ...events[0], events } : null;
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

    _appendManagedAccountMajorEvent(state, event = {}) {
        if (!state) return;
        const market = this.getState(this.config.world_book_keys.global_market) || {};
        if (!Array.isArray(state.recent_major_events)) state.recent_major_events = [];
        state.recent_major_events.push({
            id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            time_index: Number(market.current_time_index || 0),
            minute_time_index: Number(market.minute_time_index || 0),
            datetime: String(market.current_datetime || ''),
            type: String(event.type || 'account_change'),
            asset_code: String(event.asset_code || 'GLOBAL'),
            mode: String(event.mode || ''),
            content: String(event.content || '').slice(0, 240),
            observed: false,
            created_at: Date.now(),
        });
        state.recent_major_events = state.recent_major_events.slice(-20);
    }

    async _getManagedAccountStateById(accountId) {
        const states = await this.getManagedAccountStates();
        return states.find(state => state.account_id === accountId) || null;
    }

    async getManagedAccountOpenAssetCodes() {
        const states = await this.getManagedAccountStates();
        const assetCodes = new Set();
        for (const state of states) {
            for (const order of state.portfolio?.pending_orders || []) {
                if (this.config.asset_definitions[order?.asset_code]) assetCodes.add(order.asset_code);
            }
            const assets = state.portfolio?.assets || {};
            for (const assetCode of Object.keys(assets)) {
                const asset = assets[assetCode] || {};
                if ((asset.leveraged?.trades || asset.trades || []).length > 0 || (asset.spot?.trades || []).length > 0) assetCodes.add(assetCode);
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
            spotbuy: 'spot_buy',
            spotsell: 'spot_sell',
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

    async updateManagedAccountRiskControls(accountId, assetCode, riskControls, mode = 'leveraged') {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state) return false;
        const portfolio = state.portfolio || {};
        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        if (!position.type || position.totalAmount <= 0) return false;

        const normalized = this._normalizeRiskControls(riskControls) || { take_profit: null, stop_loss: null };
        const marketPrice = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`)?.current_price;
        if (!this._areRiskControlsValidForPosition(position, normalized, marketPrice)) return false;
        const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[mode];
        if (normalized.take_profit === null && normalized.stop_loss === null && normalized.trailing_stop_pct === null) {
            delete bucket.risk_controls;
        } else {
            const current = bucket.risk_controls || {};
            const existingAnchor = Number(current.trailing_anchor);
            let trailingAnchor = null;
            if (normalized.trailing_stop_pct !== null) {
                const nextAnchor = Number(marketPrice || position.avgEntryPrice);
                if (normalized.trailing_stop_pct === current.trailing_stop_pct && Number.isFinite(existingAnchor)) {
                    trailingAnchor = position.type === 'short'
                        ? Math.min(existingAnchor, nextAnchor)
                        : Math.max(existingAnchor, nextAnchor);
                } else {
                    trailingAnchor = nextAnchor;
                }
            }
            bucket.risk_controls = { ...normalized, trailing_anchor: trailingAnchor };
        }

        if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
        portfolio.actions_this_turn.push({
            id: Date.now(),
            text: `AI调整 ${assetCode} 止盈 ${normalized.take_profit || '未设置'} / 止损 ${normalized.stop_loss || '未设置'} / 移动止损 ${normalized.trailing_stop_pct ? `${normalized.trailing_stop_pct}%` : '未设置'}`,
            executedAt: null,
            intent: 'adjust_risk_controls',
            mode,
            assetCode,
            riskControls: normalized,
        });

        state.portfolio = portfolio;
        this._appendManagedAccountMajorEvent(state, {
            type: 'risk_update',
            asset_code: assetCode,
            mode,
            content: `调整风控：止盈 ${normalized.take_profit || '未设置'}，止损 ${normalized.stop_loss || '未设置'}，移动止损 ${normalized.trailing_stop_pct ? `${normalized.trailing_stop_pct}%` : '未设置'}。`,
        });
        this._recordAccountHistory(portfolio);
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async executeManagedAccountTrade(accountId, commandType, assetCode, amount = 0, leverage = 1, riskControls = null, executionOptions = null) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state || !this.config.asset_definitions[assetCode]) return false;

        const portfolio = state.portfolio || {};
        if (!portfolio.assets) portfolio.assets = {};
        const mode = executionOptions?.mode === 'spot'
            ? 'spot'
            : (executionOptions?.mode === 'leveraged'
                ? 'leveraged'
                : (String(commandType || '').toLowerCase().startsWith('spot') ? 'spot' : 'leveraged'));
        const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[mode];
        portfolio.cash = Number(portfolio.cash || 0);

        const assetData = this.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const lastCandle = assetData?.kline_minute?.slice(-1)[0] || assetData?.kline_hourly?.slice(-1)[0];
        const rawPrice = Number(executionOptions?.executionPrice ?? assetData?.current_price ?? lastCandle?.close ?? 0);
        if (!rawPrice) return false;

        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        const intent = executionOptions?.intent || this._getAccountIntentFromTradeCommand(commandType, position);
        if (!intent) return false;

        const maxLeverage = this.config.asset_definitions[assetCode]?.max_leverage || 1;
        const normalizedLeverage = mode === 'spot' ? 1 : Math.min(Math.max(1, Math.floor(Number(leverage) || 1)), maxLeverage);
        const normalizedAmount = Math.max(0, Number(amount) || 0);
        const tradeConfig = this._getTradeConfig(assetCode);
        let price = this._calculateExecutionPrice(assetCode, intent, rawPrice);
        const limitPrice = Number(executionOptions?.limitPrice);
        if (Number.isFinite(limitPrice) && limitPrice > 0) {
            price = this._getPendingOrderSide(intent) === 'buy'
                ? Math.min(price, limitPrice)
                : Math.max(price, limitPrice);
        }
        const totalPositionValue = intent === 'spot_sell'
            ? position.totalShares * price
            : intent.startsWith('close')
                ? position.positionValue
                : normalizedAmount * normalizedLeverage;
        const fee = totalPositionValue * (tradeConfig.fee_rate ?? 0.001);
        let actionText = '';

        switch (intent) {
            case 'spot_buy':
                if (normalizedAmount <= 0 || portfolio.cash < normalizedAmount + fee) return false;
                portfolio.cash -= normalizedAmount + fee;
                bucket.trades.push({ time: lastCandle?.time || 0, price, amount: normalizedAmount, type: 'long', leverage: 1 });
                actionText = `${state.owner_name} ${position.type ? '加仓' : '买入'}现货 ${assetCode}`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls, 'spot', price);
                this._recordAccountTransaction(portfolio, actionText, -normalizedAmount);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                break;

            case 'spot_sell': {
                if (position.type !== 'long') return false;
                const pnl = (price - position.avgEntryPrice) * position.totalShares;
                portfolio.cash += position.totalAmount + pnl - fee;
                this._recordAccountTransaction(portfolio, `卖出现货 ${assetCode}`, position.totalAmount + pnl);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                this._recordAccountTransaction(portfolio, `已实现盈亏 (${assetCode} 现货)`, pnl);
                bucket.trades = [];
                delete bucket.risk_controls;
                actionText = `${state.owner_name} 卖出现货 ${assetCode}`;
                break;
            }

            case 'open_long':
                if (position.type) return false;
            case 'add_long':
                if (position.type === 'short' || normalizedAmount <= 0 || portfolio.cash < normalizedAmount + fee) return false;
                portfolio.cash -= normalizedAmount + fee;
                bucket.trades.push({ time: lastCandle?.time || 0, price, amount: normalizedAmount, type: 'long', leverage: normalizedLeverage });
                actionText = `${state.owner_name} ${intent === 'open_long' ? '开多' : '加仓多'} ${assetCode} ${normalizedLeverage}x`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls, 'leveraged', price);
                this._recordAccountTransaction(portfolio, actionText, -normalizedAmount);
                this._recordAccountTransaction(portfolio, '交易手续费', -fee);
                break;

            case 'open_short':
                if (position.type) return false;
            case 'add_short':
                if (position.type === 'long' || normalizedAmount <= 0 || portfolio.cash < normalizedAmount + fee) return false;
                portfolio.cash -= normalizedAmount + fee;
                bucket.trades.push({ time: lastCandle?.time || 0, price, amount: normalizedAmount, type: 'short', leverage: normalizedLeverage });
                actionText = `${state.owner_name} ${intent === 'open_short' ? '开空' : '加仓空'} ${assetCode} ${normalizedLeverage}x`;
                actionText += this._applyRiskControls(portfolio, assetCode, riskControls, 'leveraged', price);
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
                bucket.trades = [];
                delete bucket.risk_controls;
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
                bucket.trades = [];
                delete bucket.risk_controls;
                actionText = `${state.owner_name} 平空 ${assetCode}`;
                break;
            }

            default:
                return false;
        }

        if (!portfolio.actions_this_turn) portfolio.actions_this_turn = [];
        portfolio.actions_this_turn.push({ id: Date.now(), text: actionText, executedAt: price, intent, amount: normalizedAmount, leverage: normalizedLeverage, mode, assetCode });
        state.portfolio = portfolio;
        this._appendManagedAccountMajorEvent(state, {
            type: 'trade',
            asset_code: assetCode,
            mode,
            content: `${actionText}，成交价 ${price.toFixed(5)}。`,
        });
        this._recordAccountHistory(portfolio);
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    _createManagedPendingOrderDraft(state, spec = {}) {
        const portfolio = state?.portfolio || {};
        const assetCode = String(spec.assetCode || '');
        const side = String(spec.side || '').toLowerCase();
        const mode = String(spec.mode || '').toLowerCase();
        if (!['buy', 'sell'].includes(side)) return { error: '挂单方向必须是 buy 或 sell。' };
        if (!['spot', 'leveraged'].includes(mode)) return { error: '挂单模式必须是 spot 或 leveraged。' };

        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        const commandType = mode === 'spot' ? (side === 'buy' ? 'SpotBuy' : 'SpotSell') : side;
        const intent = this._getAccountIntentFromTradeCommand(commandType, position);
        if (!intent) return { error: '无法根据账户持仓确定挂单操作。' };
        const isClosing = intent.startsWith('close') || intent === 'spot_sell';
        return this._createPendingOrderDraft({
            ...spec,
            assetCode,
            intent,
            mode,
            riskControls: isClosing ? null : spec.riskControls,
        }, portfolio);
    }

    async placeManagedAccountPendingOrder(accountId, spec = {}) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state) return false;
        this._ensurePendingOrderShape(state.portfolio);
        if (state.portfolio.pending_orders.length >= 50) return false;
        const draft = this._createManagedPendingOrderDraft(state, spec);
        if (!draft.order) return false;

        state.portfolio.pending_orders.push(draft.order);
        state.portfolio.actions_this_turn = state.portfolio.actions_this_turn || [];
        state.portfolio.actions_this_turn.push({
            id: Date.now(),
            text: `AI挂出 ${draft.order.asset_code} ${draft.order.order_type === 'limit' ? '限价' : '条件'}${draft.order.side === 'buy' ? '买单' : '卖单'}`,
            executedAt: draft.order.trigger_price,
            intent: 'place_pending_order',
            assetCode: draft.order.asset_code,
            orderId: draft.order.id,
        });
        this._appendManagedAccountMajorEvent(state, {
            type: 'pending_order_created',
            asset_code: draft.order.asset_code,
            mode: draft.order.mode,
            content: `创建${draft.order.order_type === 'limit' ? '限价' : '条件'}${draft.order.side === 'buy' ? '买单' : '卖单'} ${draft.order.id}，触发价 ${draft.order.trigger_price.toFixed(5)}。`,
        });
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async placeManagedAccountOcoOrders(accountId, specs = []) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state || !Array.isArray(specs) || specs.length !== 2) return false;
        this._ensurePendingOrderShape(state.portfolio);
        if (state.portfolio.pending_orders.length > 48) return false;
        const groupId = `oco_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const drafts = specs.map(spec => this._createManagedPendingOrderDraft(state, { ...spec, ocoGroupId: groupId }));
        if (drafts.some(draft => !draft.order)) return false;

        const orders = drafts.map(draft => draft.order);
        state.portfolio.pending_orders.push(...orders);
        state.portfolio.actions_this_turn = state.portfolio.actions_this_turn || [];
        state.portfolio.actions_this_turn.push({
            id: Date.now(),
            text: `AI挂出 ${orders[0].asset_code} OCO ${orders[0].side === 'buy' ? '买单' : '卖单'}`,
            executedAt: null,
            intent: 'place_oco_order',
            assetCode: orders[0].asset_code,
            orderIds: orders.map(order => order.id),
        });
        this._appendManagedAccountMajorEvent(state, {
            type: 'oco_order_created',
            asset_code: orders[0].asset_code,
            mode: orders[0].mode,
            content: `创建 OCO ${groupId}，下轨 ${orders[0].trigger_price.toFixed(5)}，上轨 ${orders[1].trigger_price.toFixed(5)}。`,
        });
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async cancelManagedAccountPendingOrder(accountId, orderId) {
        const state = await this._getManagedAccountStateById(accountId);
        if (!state) return false;
        this._ensurePendingOrderShape(state.portfolio);
        const index = state.portfolio.pending_orders.findIndex(order => order.id === orderId);
        if (index < 0) return false;
        const [order] = state.portfolio.pending_orders.splice(index, 1);
        this._archivePendingOrder(state.portfolio, order, 'cancelled', { cancel_reason: 'role_cancelled' });
        this._appendManagedAccountMajorEvent(state, {
            type: 'pending_order_cancelled',
            asset_code: order.asset_code,
            mode: order.mode,
            content: `撤销挂单 ${order.id}。`,
        });
        await this._writeManagedAccountState(state);
        await this.syncManagedAccountsWorldbook();
        return true;
    }

    async processManagedAccountPendingOrdersForCandle(assetCode, candle) {
        if (!candle) return null;
        const initialStates = await this.getManagedAccountStates();
        const events = [];

        for (const initialState of initialStates) {
            for (let attempt = 0; attempt < 50; attempt++) {
                const state = await this._getManagedAccountStateById(initialState.account_id);
                if (!state) break;
                this._ensurePendingOrderShape(state.portfolio);
                const orders = state.portfolio.pending_orders.filter(order => order.asset_code === assetCode);
                const candidates = orders.map(order => ({
                    ...order,
                    price: Number(order.trigger_price),
                    condition: this._getPendingOrderCondition(order.order_type, order.side),
                })).filter(candidate => candidate.condition);
                const triggered = this._selectFirstCandleTrigger(candle, candidates);
                if (!triggered) break;
                const order = orders.find(item => item.id === triggered.id);
                if (!order) break;

                state.portfolio.pending_orders = state.portfolio.pending_orders.filter(item => item.id !== order.id);
                await this._writeManagedAccountState(state);
                const rawExecutionPrice = this._getPendingOrderExecutionPrice(order, candle);
                const success = await this.executeManagedAccountTrade(
                    state.account_id,
                    order.intent,
                    order.asset_code,
                    order.amount,
                    order.leverage,
                    order.risk_controls,
                    {
                        intent: order.intent,
                        mode: order.mode,
                        executionPrice: rawExecutionPrice,
                        limitPrice: order.order_type === 'limit' ? order.trigger_price : null,
                    },
                );

                const latestState = await this._getManagedAccountStateById(state.account_id);
                if (!latestState) break;
                this._ensurePendingOrderShape(latestState.portfolio);
                const executedAction = success
                    ? [...(latestState.portfolio.actions_this_turn || [])].reverse().find(action =>
                        action.assetCode === order.asset_code && action.intent === order.intent && Number.isFinite(action.executedAt)
                    )
                    : null;
                const actualExecutionPrice = Number(executedAction?.executedAt || rawExecutionPrice);
                this._archivePendingOrder(latestState.portfolio, order, success ? 'filled' : 'rejected', {
                    filled_at: success ? Date.now() : null,
                    filled_price: success ? actualExecutionPrice : null,
                    reject_reason: success ? null : 'execution_failed',
                });
                const cancelledSiblings = [];
                if (success && order.oco_group_id) {
                    latestState.portfolio.pending_orders = latestState.portfolio.pending_orders.filter(item => {
                        if (item.oco_group_id !== order.oco_group_id) return true;
                        cancelledSiblings.push(item);
                        this._archivePendingOrder(latestState.portfolio, item, 'cancelled', { cancel_reason: 'oco_peer_filled' });
                        return false;
                    });
                }
                if (!success) {
                    this._appendManagedAccountMajorEvent(latestState, {
                        type: 'pending_order_rejected',
                        asset_code: order.asset_code,
                        mode: order.mode,
                        content: `挂单 ${order.id} 已触发，但交易校验未通过。`,
                    });
                }
                await this._writeManagedAccountState(latestState);
                events.push({
                    account_id: state.account_id,
                    order,
                    success,
                    price: actualExecutionPrice,
                    cancelledSiblings,
                });
            }
        }

        if (events.length > 0) await this.syncManagedAccountsWorldbook();
        return events.length > 0 ? { triggered: true, events } : null;
    }

    async processManagedAccountTradeCommand(command) {
        if (command.module !== 'Trade') return false;
        const [accountId, assetCode] = command.args;
        if (typeof accountId !== 'string') return false;

        if (command.type === 'CancelOrder') {
            return typeof assetCode === 'string'
                ? await this.cancelManagedAccountPendingOrder(accountId, assetCode)
                : false;
        }

        if (typeof assetCode !== 'string') return false;

        if (command.type === 'PlaceLimit' || command.type === 'PlaceStop') {
            const [, , side, mode, amount = 0, leverage = 1, triggerPrice = 0, takeProfit = 0, stopLoss = 0, trailingStopPct = 0] = command.args;
            return await this.placeManagedAccountPendingOrder(accountId, {
                assetCode,
                side,
                mode,
                amount: Number(amount) || 0,
                leverage: Number(leverage) || 1,
                triggerPrice: Number(triggerPrice) || 0,
                orderType: command.type === 'PlaceLimit' ? 'limit' : 'stop',
                riskControls: {
                    take_profit: Number(takeProfit) || null,
                    stop_loss: Number(stopLoss) || null,
                    trailing_stop_pct: Number(trailingStopPct) || null,
                },
            });
        }

        if (command.type === 'PlaceOCO') {
            const [, , side, mode, amount = 0, leverage = 1, lowerPrice = 0, upperPrice = 0, takeProfit = 0, stopLoss = 0, trailingStopPct = 0] = command.args;
            const normalizedSide = String(side || '').toLowerCase();
            const common = {
                assetCode,
                side: normalizedSide,
                mode,
                amount: Number(amount) || 0,
                leverage: Number(leverage) || 1,
                riskControls: {
                    take_profit: Number(takeProfit) || null,
                    stop_loss: Number(stopLoss) || null,
                    trailing_stop_pct: Number(trailingStopPct) || null,
                },
            };
            return await this.placeManagedAccountOcoOrders(accountId, [
                { ...common, orderType: normalizedSide === 'buy' ? 'limit' : 'stop', triggerPrice: Number(lowerPrice) || 0 },
                { ...common, orderType: normalizedSide === 'buy' ? 'stop' : 'limit', triggerPrice: Number(upperPrice) || 0 },
            ]);
        }

        if (command.type === 'SetRisk') {
            const [, , takeProfit = 0, stopLoss = 0, trailingStopPct = 0] = command.args;
            return await this.updateManagedAccountRiskControls(accountId, assetCode, {
                take_profit: Number(takeProfit) || null,
                stop_loss: Number(stopLoss) || null,
                trailing_stop_pct: Number(trailingStopPct) || null,
            }, 'leveraged');
        }

        if (command.type === 'SetSpotRisk') {
            const [, , takeProfit = 0, stopLoss = 0, trailingStopPct = 0] = command.args;
            return await this.updateManagedAccountRiskControls(accountId, assetCode, {
                take_profit: Number(takeProfit) || null,
                stop_loss: Number(stopLoss) || null,
                trailing_stop_pct: Number(trailingStopPct) || null,
            }, 'spot');
        }

        const [, , amount = 0, leverage = 1, takeProfit = 0, stopLoss = 0, trailingStopPct = 0] = command.args;
        return await this.executeManagedAccountTrade(accountId, command.type, assetCode, Number(amount) || 0, Number(leverage) || 1, {
            take_profit: Number(takeProfit) || null,
            stop_loss: Number(stopLoss) || null,
            trailing_stop_pct: Number(trailingStopPct) || null,
        });
    }

    async closeManagedAccountPositionAtPrice(state, assetCode, closePrice, reason = 'risk_control', mode = 'leveraged') {
        const portfolio = state.portfolio || {};
        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        if (!position.type || position.totalAmount <= 0 || !portfolio.assets?.[assetCode]) return false;

        const feeBase = mode === 'spot' ? position.totalShares * closePrice : position.positionValue;
        const fee = feeBase * (this._getTradeConfig(assetCode).fee_rate ?? 0.001);
        const pnl = position.type === 'long'
            ? (closePrice - position.avgEntryPrice) * position.totalShares
            : (position.avgEntryPrice - closePrice) * position.totalShares;
        portfolio.cash = (portfolio.cash || 0) + position.totalAmount + pnl - fee;
        const bucket = this._ensurePortfolioAssetBuckets(portfolio, assetCode)[mode];
        bucket.trades = [];
        delete bucket.risk_controls;
        const label = reason === 'take_profit'
            ? '止盈'
            : (reason === 'liquidation' ? '爆仓强平' : (reason === 'trailing_stop' ? '移动止损' : '止损'));
        this._recordAccountTransaction(portfolio, `${label}平仓 ${assetCode}`, position.totalAmount + pnl);
        this._recordAccountTransaction(portfolio, '交易手续费', -fee);
        this._recordAccountTransaction(portfolio, `已实现盈亏 (${assetCode})`, pnl);
        this._recordAccountHistory(portfolio);
        state.portfolio = portfolio;
        this._appendManagedAccountMajorEvent(state, {
            type: reason,
            asset_code: assetCode,
            mode,
            content: `${label}触发，成交价 ${Number(closePrice).toFixed(5)}，已实现盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}。`,
        });
        await this._writeManagedAccountState(state);
        return {
            triggered: true,
            type: reason,
            label,
            price: closePrice,
            account_id: state.account_id,
            mode,
        };
    }

    async processManagedAccountRiskForCandle(assetCode, candle, options = {}) {
        if (!candle) return false;
        const states = await this.getManagedAccountStates();
        let changed = false;
        const events = [];
        const skipAccountModes = new Set(options.skipAccountModes || []);

        for (const state of states) {
            const portfolio = state.portfolio || {};
            let stateChanged = false;
            for (const mode of ['leveraged', 'spot']) {
                if (skipAccountModes.has(`${state.account_id}:${mode}`)) continue;
                const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
                if (!position.type || position.totalAmount <= 0) continue;
                const controls = portfolio.assets?.[assetCode]?.[mode]?.risk_controls || {};
                const takeProfit = Number(controls.take_profit);
                const stopLoss = Number(controls.stop_loss);
                const candidates = [];
                if (position.type === 'long') {
                    if (Number.isFinite(takeProfit) && takeProfit > 0) candidates.push({ type: 'take_profit', price: takeProfit, condition: 'above' });
                    if (Number.isFinite(stopLoss) && stopLoss > 0) candidates.push({ type: 'stop_loss', price: stopLoss, condition: 'below' });
                    if (mode === 'leveraged' && position.isLeveraged && position.liquidationPrice > 0) candidates.push({ type: 'liquidation', price: position.liquidationPrice, condition: 'below' });
                } else {
                    if (Number.isFinite(takeProfit) && takeProfit > 0) candidates.push({ type: 'take_profit', price: takeProfit, condition: 'below' });
                    if (Number.isFinite(stopLoss) && stopLoss > 0) candidates.push({ type: 'stop_loss', price: stopLoss, condition: 'above' });
                    if (mode === 'leveraged' && position.isLeveraged && position.liquidationPrice > 0) candidates.push({ type: 'liquidation', price: position.liquidationPrice, condition: 'above' });
                }
                const fixedTrigger = this._selectFirstCandleTrigger(candle, candidates);
                const trailingResult = this._evaluateTrailingStop(candle, position, controls);
                const trailingTrigger = trailingResult?.triggered ? {
                    type: 'trailing_stop',
                    price: trailingResult.price,
                    pathPosition: trailingResult.pathPosition,
                } : null;
                const firstTrigger = trailingTrigger && (!fixedTrigger || trailingTrigger.pathPosition < fixedTrigger.pathPosition)
                    ? trailingTrigger
                    : fixedTrigger;
                if (!firstTrigger && trailingResult && trailingResult.anchor !== Number(controls.trailing_anchor)) {
                    portfolio.assets[assetCode][mode].risk_controls.trailing_anchor = trailingResult.anchor;
                    stateChanged = true;
                    changed = true;
                }
                if (!firstTrigger) continue;
                const result = await this.closeManagedAccountPositionAtPrice(
                    state,
                    assetCode,
                    Number(firstTrigger.executionPrice ?? firstTrigger.price),
                    firstTrigger.type,
                    mode,
                );
                if (result?.triggered) {
                    changed = true;
                    stateChanged = true;
                    events.push({
                        account_id: state.account_id,
                        type: result.type,
                        label: result.label,
                        price: result.price,
                        mode: result.mode,
                    });
                }
            }
            if (stateChanged) {
                state.portfolio = portfolio;
                await this._writeManagedAccountState(state);
            }
        }

        if (changed) await this.syncManagedAccountsWorldbook();
        return changed ? { triggered: true, events } : null;
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
                for (const position of Object.values(this.positionCalculator.calculateAll(assetCode, portfolio))) {
                    if (position.totalAmount <= 0) continue;
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
