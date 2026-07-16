/**
 * SillyView - Main Application Class (v6.2 - Sync & Trade Logic Fix)
 * Orchestrates all modules and handles the core application lifecycle and state management.
 * Contains core trade execution logic.
 */
'use strict';

import { Logger } from '../logger.js';
import { SillyViewConfig } from '../config.js';

export class SillyViewApp {
    constructor() {
        this.parentWin = window.parent;
        this.st = this.parentWin.SillyTavern;
        this.th = this.parentWin.TavernHelper;
        this.st_context = this.st.getContext();

        this.processorTimeout = null;
        this.previousStateSnapshot = null;
        this.quickModeStartState = null;
        this.lastMinuteAdvanceMessageId = null;

        // Dependencies are set in init() by the main script.js entry point
        this.data = null;
        this.ui = null;
        this.events = null;
        this.commandParser = null;
        this.aiDirector = null;
        this.backgroundAI = null;
        this.marketSimulator = null;
        this.positionCalculator = null;
        this.logger = null;
        this.dependencies = null; // To be initialized in init()
    }

    // Initialize with dependencies provided by script.js
    init(dependencies) {
        this.dependencies = dependencies; // Store all dependencies
        this.data = dependencies.data;
        this.ui = dependencies.ui;
        this.events = dependencies.events;
        this.commandParser = dependencies.commandParser;
        this.aiDirector = dependencies.aiDirector;
        this.backgroundAI = dependencies.backgroundAI;
        this.marketSimulator = dependencies.marketSimulator;
        this.positionCalculator = dependencies.positionCalculator;
        this.tradeView = dependencies.tradeView;
        this.assetsView = dependencies.assetsView;
        this.newsView = dependencies.newsView;
        this.logView = dependencies.logView;
        this.modals = dependencies.modals;
        this.logger = dependencies.logger; // FIX: Assign logger from dependencies


        // Manually wire up the circular dependencies to fix the initialization crash
        this.data.ui = this.ui;
        this.ui.dependencies.events = this.events;
        this.tradeView.ui = this.ui; // FIX: Inject UI renderer into TradeView

        this.logger.log("SillyViewApp initializing with dependencies wired...");
        this.ui.loadPanelHtml().then(() => {
            this.events.bindInitialEvents();
            this.setupEventListeners();
            this.logger.success("SillyViewApp initialization complete.");
        });
    }
    
    async _checkLiquidations(livePrices = null) {
        const allAssetCodes = Object.keys(SillyViewConfig.asset_definitions);

        for (const assetCode of allAssetCodes) {
            const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
            if (!portfolio) continue;

            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (position.isLeveraged && position.liquidationPrice > 0) {
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
                if (!assetData) continue;

                // Use live price if available for this specific asset, otherwise use the stored current_price
                const currentPrice = livePrices && livePrices[assetCode] !== undefined ? livePrices[assetCode] : assetData.current_price;

                if ((position.type === 'long' && currentPrice <= position.liquidationPrice) || (position.type === 'short' && currentPrice >= position.liquidationPrice)) {
                    this.logger.error(`爆仓! ${assetCode} 价格 (${currentPrice.toFixed(4)}) 触及强平价格 (${position.liquidationPrice.toFixed(4)})。`);
                    
                    // Stop animation immediately (circuit breaker)
                    this.ui.isAnimating = false;
                    
                    // Liquidate position using the exact price that triggered it
                    await this.data.liquidatePosition(assetCode, currentPrice);
                    
                    // Render UI after liquidation
                    this.ui.renderAll();
                    
                    // Stop checking other assets, as the animation will be cancelled.
                    return true;
                }
            }
        }
        return false; // No liquidation occurred
    }

    async _checkRiskControlsForHourlyCandles(assetCode, hourlyCandles) {
        if (!Array.isArray(hourlyCandles) || hourlyCandles.length === 0) return false;

        let triggered = false;
        for (const candle of hourlyCandles) {
            const result = await this.data.triggerRiskControlsForCandle(assetCode, candle);
            if (result?.triggered) {
                triggered = true;
                this.dependencies.win.toastr.info(
                    `${assetCode} ${result.triggerType === 'take_profit' ? '止盈' : '止损'}触发，成交价 ${result.price.toFixed(4)}。`
                );
                break;
            }
        }

        if (triggered) {
            this.ui.renderAll();
        }
        return triggered;
    }

    debouncedMainProcessor(msgId, isReprocessing = false) {
        clearTimeout(this.processorTimeout);
        this.processorTimeout = setTimeout(async () => {
            if (isReprocessing && this.previousStateSnapshot) {
                this.data.restoreStateFromSnapshot(this.previousStateSnapshot);
                this.ui.renderAll();
            }
            this.previousStateSnapshot = this.data.createSnapshot();
            await this.processSingleMessage(msgId);
        }, 350);
    }

    async processSingleMessage(msgId) {
        const messages = this.th.getChatMessages(msgId);
        if (!messages || messages.length === 0 || messages[0].is_user) { return; }
        const msg = messages[0].message;
        return await this.processGeneratedMarketText(msg);
    }

    async processGeneratedMarketText(msg, options = {}) {
        const requiredAssetCodes = options.requiredAssetCodes || [];

        // **FIX**: Check if this turn started as a key moment BEFORE processing.
        const marketBefore = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        const wasKeyMoment = marketBefore && marketBefore.remaining_candles <= 0;
    
        const commands = this.commandParser.parse(msg);
        let hasAdvanced = false;
        let hasUpdatedFinancials = false;
        let hasUpdatedTimeline = false;
        let hasUpdatedTargets = false;
        let maxAdvancedTimeIndex = 0;
        const headlineAssetCodes = new Set();
        const advancedAssetCodes = new Set();

        for (const command of commands) {
            let newCandles = null;
            let assetCodeForUpdate = null;

            if (command.module === 'Market' && command.type === 'SetLongTarget') {
                const [assetCode, targetPrice, hours, pattern, reason, confidence] = command.args;
                if (assetCode && typeof targetPrice === 'number' && typeof hours === 'number') {
                    hasUpdatedTargets = await this.data.setMarketTarget(assetCode, 'long', {
                        target_price: targetPrice,
                        duration: hours,
                        pattern,
                        reason,
                        confidence,
                    });
                } else {
                    Logger.warn('收到了格式不正确的 Market.SetLongTarget 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Market' && command.type === 'SetShortTarget') {
                const [assetCode, targetPrice, minutes, pattern, reason, confidence] = command.args;
                if (assetCode && typeof targetPrice === 'number' && typeof minutes === 'number') {
                    hasUpdatedTargets = await this.data.setMarketTarget(assetCode, 'short', {
                        target_price: targetPrice,
                        duration: minutes,
                        pattern,
                        reason,
                        confidence,
                    });
                } else {
                    Logger.warn('收到了格式不正确的 Market.SetShortTarget 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Market' && command.type === 'ClearTarget') {
                const [assetCode, type = 'all'] = command.args;
                if (assetCode) {
                    await this.data.clearMarketTarget(assetCode, ['long', 'short'].includes(type) ? type : 'all');
                    hasUpdatedTargets = true;
                } else {
                    Logger.warn('收到了格式不正确的 Market.ClearTarget 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Market' && command.type === 'Advance') {
                const [assetCode, timeframe, close_price, pattern] = command.args;
                assetCodeForUpdate = assetCode;
                if (assetCode && timeframe && typeof close_price === 'number' && pattern) {
                    newCandles = this.marketSimulator.calculateCandlesFromAI(command.args);
                    hasAdvanced = true;
                } else {
                    Logger.warn('收到了格式不正确的 Market.Advance 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Market' && command.type === 'AdvanceSeries') {
                const [asset_code, timeframe, num_candles, final_close_price, pattern] = command.args;
                assetCodeForUpdate = asset_code;
                 if (asset_code && timeframe && typeof num_candles === 'number' && typeof final_close_price === 'number' && pattern) {
                    newCandles = this.marketSimulator.calculateCandleSeriesFromAI(command.args);
                    hasAdvanced = true;
                } else {
                    Logger.warn('收到了格式不正确的 Market.AdvanceSeries 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Player') {
                const [amount, reason] = command.args;
                if (typeof amount === 'number' && typeof reason === 'string') {
                    if (command.type === 'AddDebt') {
                        await this.data.addDebtOnly(amount, reason);
                    } else {
                        const isAdd = command.type === 'AddCash';
                        await this.data.logTransaction(reason, isAdd ? amount : -amount);
                    }
                    Logger.log(`Processed Player command: ${command.type} of ${amount} for reason: ${reason}`);
                    hasUpdatedFinancials = true;
                }
            }
            else if (command.module === 'Loan') {
                const [amount, reason] = command.args;
                if (typeof amount === 'number' && amount > 0 && typeof reason === 'string') {
                    if (command.type === 'Grant') {
                        await this.data.grantLoanByAI(amount, reason);
                    } else if (command.type === 'Repay') {
                        await this.data.forceRepayLoanByAI(amount, reason);
                    }
                    hasUpdatedFinancials = true;
                }
            }
            else if (command.module === 'Time' && command.type === 'Set') {
                const [time, period, season, weather] = command.args;
                if (typeof time === 'string' && typeof period === 'string') {
                    await this.data.setWorldTime({ time, period, season, weather });
                    hasUpdatedTimeline = true;
                } else {
                    Logger.warn('收到了格式不正确的 Time.Set 指令，已忽略:', command.args);
                }
            }
            
            if (newCandles && newCandles.length > 0 && assetCodeForUpdate) {
                const minuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCodeForUpdate, newCandles);
                await this.ui.handleAiResponse(newCandles, msg, assetCodeForUpdate, minuteCandles);
                advancedAssetCodes.add(assetCodeForUpdate);
                headlineAssetCodes.add(assetCodeForUpdate);
                maxAdvancedTimeIndex = Math.max(maxAdvancedTimeIndex, newCandles[newCandles.length - 1].time || 0);
                await this._checkRiskControlsForHourlyCandles(assetCodeForUpdate, newCandles);
                await this._checkLiquidations();
            }
        }

        const missingAssetCodes = requiredAssetCodes.filter(assetCode => !advancedAssetCodes.has(assetCode));
        if (missingAssetCodes.length > 0) {
            Logger.warn(`AI未推进这些相关资产，使用本地市场模拟补齐: ${missingAssetCodes.join(', ')}`);
            let maxFallbackTime = 0;
            for (const assetCode of missingAssetCodes) {
                const fallbackCandles = this.marketSimulator.calculateCandlesForBackgroundAsset(assetCode, 1);
                if (fallbackCandles.length === 0) continue;
                const fallbackMinutes = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCode, fallbackCandles);
                await this.data.updateAssetCandles(assetCode, fallbackCandles, fallbackMinutes);
                const assetDef = SillyViewConfig.asset_definitions[assetCode];
                if (assetDef) await this.data.aggregateHourlyToDaily(assetCode, assetDef.trading_hours_per_day);
                await this._checkRiskControlsForHourlyCandles(assetCode, fallbackCandles);
                maxFallbackTime = Math.max(maxFallbackTime, fallbackCandles[fallbackCandles.length - 1].time);
                headlineAssetCodes.add(assetCode);
                maxAdvancedTimeIndex = Math.max(maxAdvancedTimeIndex, fallbackCandles[fallbackCandles.length - 1].time || 0);
                hasAdvanced = true;
            }
            if (maxFallbackTime > 0) {
                await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
                    market.current_time_index = Math.max(market.current_time_index || 0, maxFallbackTime);
                    market.minute_time_index = Math.max(market.minute_time_index || 0, maxFallbackTime * 60);
                    return market;
                });
            }
            await this._checkLiquidations();
            this.ui.renderAll();
        }

        if (maxAdvancedTimeIndex > 0) {
            await this._recordHeadlineOnce(msg, maxAdvancedTimeIndex, [...headlineAssetCodes]);
        }

        // **FIX**: If the turn started as a key moment, ALWAYS reset the candle count, regardless of what the AI responded with.
        await this.data.pruneExpiredMarketTargets();

        if (wasKeyMoment) {
            this.logger.log("AI turn for key moment has finished. Resetting market breath.");
            await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
                m.remaining_candles = Math.floor(Math.random() * 30) + 1;
                this.logger.log(`AI turn complete. New random candle count: ${m.remaining_candles}`);
                return m;
            });
            this.ui.updateUIVisibility();
        } else if (hasUpdatedFinancials || hasUpdatedTimeline || hasUpdatedTargets) {
            this.ui.renderAll();
        } else if (!hasAdvanced) {
            // If no commands were processed, ensure buttons are re-enabled
            this.ui.tradeView.updateActionButtonsState(false, false);
        }
        
        await this.data.updateAIContext();
        await this.data.saveAllEntries();
    }

    _extractHeadline(msg) {
        const headlineMatch = String(msg || '').match(/<headline>([\s\S]*?)<\/headline>/i);
        return headlineMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';
    }

    async _recordHeadlineOnce(msg, timeIndex, assetCodes = []) {
        const headline = this._extractHeadline(msg);
        if (!headline) return;

        const normalizedHeadline = headline.toLowerCase();
        const uniqueAssetCodes = [...new Set(assetCodes)].filter(Boolean);
        const assetCode = uniqueAssetCodes.length === 1 ? uniqueAssetCodes[0] : 'GLOBAL';

        await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
            if (!Array.isArray(market.news_feed)) market.news_feed = [];
            const seenNews = new Set();
            market.news_feed = market.news_feed.filter(item => {
                const key = `${Number(item.time_index)}::${String(item.headline || '').trim().toLowerCase()}`;
                if (seenNews.has(key)) return false;
                seenNews.add(key);
                return true;
            });

            const alreadyExists = market.news_feed.some(item =>
                Number(item.time_index) === Number(timeIndex) &&
                String(item.headline || '').trim().toLowerCase() === normalizedHeadline
            );

            if (!alreadyExists) {
                market.news_feed.unshift({ time_index: timeIndex, headline, asset_code: assetCode });
                if (market.news_feed.length > 50) market.news_feed = market.news_feed.slice(0, 50);
            }
            return market;
        });
    }
    
    async onQuickModeToggled(isEnabled) {
        await this.data.setQuickModeEnabled(isEnabled);
        if (isEnabled) {
            this.quickModeStartState = this.data.createSnapshot();
            Logger.log("快速模式已启用，状态快照已创建。");
        } else {
            this.quickModeStartState = null;
            Logger.log("快速模式已手动禁用。");
        }
        this.ui.updateUIVisibility();
    }
    
    async advanceQuickModeHour() {
        if (!this.data.isQuickModeEnabled() || this.ui.isAnimating) return;

        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        if (market.remaining_candles <= 0) {
            this.dependencies.win.toastr.info('市场进入关键时刻，请结束回合等待AI导演的下一步指示。');
            this.ui.updateUIVisibility(); // Force UI update to show the "End Turn" button
            return;
        }

        Logger.log(`快速模式: 推进 1 小时...`);
    
        const activeAssetCode = this.ui.currentAsset;
        const allAssetCodes = Object.keys(SillyViewConfig.asset_definitions);
        let activeMinuteCandles = [];
    
        await this.marketSimulator.advanceMarketRegime(1);
        await this.marketSimulator.advanceMacroState(1);
        for (const assetCode of allAssetCodes) {
            const newCandles = this.marketSimulator.calculateCandlesForQuickMode(assetCode, 1);
            const minuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCode, newCandles);
            if (assetCode === activeAssetCode) activeMinuteCandles = minuteCandles;
            await this.data.updateAssetCandles(assetCode, newCandles, minuteCandles);
            await this._checkRiskControlsForHourlyCandles(assetCode, newCandles);
        }
        
        await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
            m.current_time_index = (m.current_time_index || 0) + 1;
            m.minute_time_index = Math.max(m.minute_time_index || 0, m.current_time_index * 60);
            m.remaining_candles -= 1;
            return m;
        });

        const activeAssetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${activeAssetCode}`);
        const candlesToAnimate = this.ui.currentTimeframe === 'MINUTE'
            ? activeMinuteCandles
            : activeAssetData.kline_hourly.slice(-1);
        await this.ui.animateCandles(candlesToAnimate, 1000); 
        
        await this._checkLiquidations();
        await this.data.recordAssetHistory();
        await this.data.updateAIContext();
        await this.data.saveAllEntries();
        
        this.ui.renderAll(); 
        Logger.log(`快速模式: 推进 1 小时完成。`);
    }

    async commitAndAdvance() {
        if (this.ui.isAnimating) return;
        
        const isQuickMode = this.data.isQuickModeEnabled();
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        const isKeyMoment = market && market.remaining_candles <= 0;

        if (isKeyMoment) {
            Logger.log("市场呼吸耗尽，强制进入AI回合...");
            if (isQuickMode) {
                await this.onQuickModeToggled(false); 
            }
        } else if (isQuickMode) {
            const activeAssetCode = this.ui.currentAsset;
            const assetDef = SillyViewConfig.asset_definitions[activeAssetCode];
            const hoursToAdvance = Math.min(assetDef.trading_hours_per_day, market.remaining_candles);
            
            if (hoursToAdvance < assetDef.trading_hours_per_day) {
                this.dependencies.win.toastr.info(`由于市场进入关键时刻，本次仅推进了 ${hoursToAdvance} 小时。`);
            }
    
            await this.marketSimulator.advanceMarketRegime(hoursToAdvance);
            await this.marketSimulator.advanceMacroState(hoursToAdvance);
            const newCandles = this.marketSimulator.calculateCandlesForQuickMode(activeAssetCode, hoursToAdvance);
            const activeMinuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(activeAssetCode, newCandles);
            
            for (const assetCode of Object.keys(SillyViewConfig.asset_definitions)) {
                 if (assetCode !== activeAssetCode) {
                    const bgAssetDef = SillyViewConfig.asset_definitions[assetCode];
                    const bgHours = bgAssetDef.trading_hours_per_day;
                    const bgCandles = this.marketSimulator.calculateCandlesForBackgroundAsset(assetCode, bgHours);
                    const bgMinuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCode, bgCandles);
                    await this.data.updateAssetCandles(assetCode, bgCandles, bgMinuteCandles);
                    await this.data.aggregateHourlyToDaily(assetCode, bgHours);
                    await this._checkRiskControlsForHourlyCandles(assetCode, bgCandles);
                 }
            }
            
            await this.ui.animateCandles(this.ui.currentTimeframe === 'MINUTE' ? activeMinuteCandles : newCandles, 2000);
            
            if (this.ui.isAnimating === false) { 
                await this.data.updateAssetCandles(activeAssetCode, newCandles, activeMinuteCandles);
                await this.data.aggregateHourlyToDaily(activeAssetCode, hoursToAdvance);
                await this._checkRiskControlsForHourlyCandles(activeAssetCode, newCandles);
                await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
                    m.current_time_index = (m.current_time_index || 0) + hoursToAdvance;
                    m.minute_time_index = Math.max(m.minute_time_index || 0, m.current_time_index * 60);
                    m.remaining_candles -= hoursToAdvance;
                    return m;
                });
                this.data.clearActionsThisTurn();
                await this.data.updateAIContext();
                this.ui.renderAll();
            }
            return;
        }

        // AI Mode
        await this.data.accrueInterest();
        const currentTimeframe = this.ui.currentTimeframe === 'MINUTE' ? 'HOURLY' : this.ui.currentTimeframe;
        const logTimeUnit = currentTimeframe === 'HOURLY' ? '一小时' : '一天';
        Logger.log(`正在推进${logTimeUnit} (AI 模式)...`);
        this.ui.tradeView.updateActionButtonsState(false, true);

        const actionsThisTurn = this.data.getActionsThisTurn();
        const tradedAssetCodes = new Set(actionsThisTurn.map(a => a.assetCode));
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const openPositionCodes = Object.keys(portfolio.assets || {})
            .filter(assetCode => (portfolio.assets[assetCode]?.trades || []).length > 0);
        const activeAssetsForAI = new Set([this.ui.currentAsset, ...tradedAssetCodes, ...openPositionCodes]);
        
        await this.data.updateAIContext();
        const finalPrompt = await this.aiDirector.buildAdvanceTurnPrompt(actionsThisTurn, activeAssetsForAI, this.ui.currentAsset, currentTimeframe);

        try {
            let marketResponse = '';
            try {
                marketResponse = await this.backgroundAI.generateMarketResponse(finalPrompt);
            } catch (e) {
                Logger.error("Error running background AI for next turn:", e);
                this.dependencies.win.toastr.error(`后台市场模型生成失败: ${e.message || e}`);
                return;
            }

            try {
                await this.processGeneratedMarketText(marketResponse, { requiredAssetCodes: [...activeAssetsForAI] });
            } catch (e) {
                Logger.error("Error processing background market response:", e);
                this.dependencies.win.toastr.error(`后台市场指令处理失败: ${e.message || e}`);
                return;
            }

            this.data.clearActionsThisTurn();
            this.ui.tradeView.renderThisTurnActions();

            await this.data.recordAssetHistory();
            await this.data.saveAllEntries();
            Logger.log("AI回合后台推进完成。");
        } finally {
            this.ui.tradeView.updateActionButtonsState(false, false);
        }
    }
    
    async syncQuickModeWithAI() {
        if (!this.quickModeStartState) {
            this.logger.warn("尝试同步，但快速模式未激活或起始状态丢失。");
            return;
        }

        this.logger.log("正在将快速模式结果与AI同步...");
        
        const stateSnapshotForSync = this.data.createSnapshot();
        const summaryPrompt = this.aiDirector.buildSyncPrompt(this.quickModeStartState, stateSnapshotForSync);
        
        if (!summaryPrompt) {
            this.logger.error("无法构建同步提示，因为快照无效。");
            return;
        }
        
        this.logger.log("正在后台发送快速模式摘要Prompt给AI:", summaryPrompt);

        try {
            const syncResponse = await this.backgroundAI.generateMarketResponse(summaryPrompt);
            try {
                await this.processGeneratedMarketText(syncResponse);
            } catch (processError) {
                this.logger.error("处理后台同步结果时出错:", processError);
                this.dependencies.win.toastr.error(`后台同步结果处理失败: ${processError.message || processError}`);
            }
        } catch (e) {
            this.logger.error("后台AI进行快速模式同步时出错:", e);
            this.dependencies.win.toastr.error(`后台同步失败: ${e.message || e}`);
        } finally {
            await this.onQuickModeToggled(false);
            this.data.clearActionsThisTurn();
            this.ui.renderAll();
        }
    }
    
    async executeTrade(action, amount, assetCode, executionPrice, leverage, riskControls = null) {
        Logger.log(`Executing trade: ${action} ${amount} of ${assetCode} @ ${executionPrice} with ${leverage}x leverage`);

        const success = await this.data.executeAndRecordTrade(action, amount, assetCode, executionPrice, leverage, riskControls);

        if (success) {
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            this.ui.renderAll();
        }
    }

    async advanceMinutesForUserMessage(msgId) {
        if (this.lastMinuteAdvanceMessageId === msgId) return;

        const messages = this.th.getChatMessages(msgId);
        if (!messages || messages.length === 0 || !messages[0].is_user) return;
        this.lastMinuteAdvanceMessageId = msgId;

        const loaded = await this.data.ensureStateLoaded();
        if (!loaded) return;

        const barsToAdvance = Math.floor(Math.random() * 2) + 1;
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const assetCodes = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        let maxMinuteTime = 0;

        for (const assetCode of assetCodes) {
            const minuteCandles = this.marketSimulator.calculateMinuteCandlesForUserInput(assetCode, barsToAdvance);
            if (minuteCandles.length === 0) continue;

            await this.data.appendMinuteCandles(assetCode, minuteCandles);
            maxMinuteTime = Math.max(maxMinuteTime, minuteCandles[minuteCandles.length - 1].time);
        }

        if (maxMinuteTime > 0) {
            await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
                market.minute_time_index = Math.max(market.minute_time_index || 0, maxMinuteTime);
                return market;
            });

            await this._checkLiquidations();
            await this.data.updateAIContext();
            await this.data.saveAllEntries();

            if (this.ui.isPanelVisible) {
                this.ui.renderAll();
            }
        }
    }


    setupEventListeners() {
        const { eventSource, eventTypes } = this.st_context;
        if (eventTypes.USER_MESSAGE_RENDERED) {
            eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (id) => {
                this.advanceMinutesForUserMessage(id).catch(error => {
                    this.logger.warn('Failed to advance minute candles after user message rendered:', error);
                });
            });
        }
        if (eventTypes.MESSAGE_SENT) {
            eventSource.on(eventTypes.MESSAGE_SENT, (id) => {
                setTimeout(() => {
                    this.advanceMinutesForUserMessage(id).catch(error => {
                        this.logger.warn('Failed to advance minute candles for user message:', error);
                    });
                }, 100);
            });
        }
        eventSource.on(eventTypes.MESSAGE_RECEIVED, (id) => this.debouncedMainProcessor(id, false));
        eventSource.on(eventTypes.MESSAGE_EDITED, (id) => this.debouncedMainProcessor(id, true));
        eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => this.debouncedMainProcessor(id, true));
        eventSource.on(eventTypes.MESSAGE_DELETED, async (id) => {
            const lastMessageId = await this.th.getLastMessageId();
            if (id === lastMessageId + 1 && this.previousStateSnapshot) {
                 this.data.restoreStateFromSnapshot(this.previousStateSnapshot);
                 this.previousStateSnapshot = null;
                 await this.data.saveAllEntries();
                 this.ui.renderAll();
            }
        });
        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            this.previousStateSnapshot = null;
            if (this.ui.isPanelVisible) {
                this.data.loadInitialState();
            }
        });
    }
}
