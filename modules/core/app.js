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

        // Dependencies are set in init() by the main script.js entry point
        this.data = null;
        this.ui = null;
        this.events = null;
        this.commandParser = null;
        this.aiDirector = null;
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

        // **FIX**: Check if this turn started as a key moment BEFORE processing.
        const marketBefore = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        const wasKeyMoment = marketBefore && marketBefore.remaining_candles <= 0;
    
        const commands = this.commandParser.parse(msg);
        let hasAdvanced = false;
        let hasUpdatedFinancials = false;
        let hasUpdatedTimeline = false;

        for (const command of commands) {
            let newCandles = null;
            let assetCodeForUpdate = null;

            if (command.module === 'Market' && command.type === 'Advance') {
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
                await this.ui.handleAiResponse(newCandles, msg, assetCodeForUpdate);
                await this._checkLiquidations();
            }
        }

        // **FIX**: If the turn started as a key moment, ALWAYS reset the candle count, regardless of what the AI responded with.
        if (wasKeyMoment) {
            this.logger.log("AI turn for key moment has finished. Resetting market breath.");
            await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
                m.remaining_candles = Math.floor(Math.random() * 30) + 1;
                this.logger.log(`AI turn complete. New random candle count: ${m.remaining_candles}`);
                return m;
            });
            this.ui.updateUIVisibility();
        } else if (hasUpdatedFinancials || hasUpdatedTimeline) {
            this.ui.renderAll();
        } else if (!hasAdvanced) {
            // If no commands were processed, ensure buttons are re-enabled
            this.ui.tradeView.updateActionButtonsState(false, false);
        }
        
        await this.data.updateAIContext();
        await this.data.saveAllEntries();
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
    
        await this.marketSimulator.advanceMarketRegime(1);
        await this.marketSimulator.advanceMacroState(1);
        for (const assetCode of allAssetCodes) {
            const newCandles = this.marketSimulator.calculateCandlesForQuickMode(assetCode, 1);
            await this.data.updateAssetCandles(assetCode, newCandles);
        }
        
        await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
            m.current_time_index = (m.current_time_index || 0) + 1;
            m.remaining_candles -= 1;
            return m;
        });

        const activeAssetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${activeAssetCode}`);
        const candlesToAnimate = activeAssetData.kline_hourly.slice(-1);
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
            
            for (const assetCode of Object.keys(SillyViewConfig.asset_definitions)) {
                 if (assetCode !== activeAssetCode) {
                    const bgAssetDef = SillyViewConfig.asset_definitions[assetCode];
                    const bgHours = bgAssetDef.trading_hours_per_day;
                    const bgCandles = this.marketSimulator.calculateCandlesForBackgroundAsset(assetCode, bgHours);
                    await this.data.updateAssetCandles(assetCode, bgCandles);
                    await this.data.aggregateHourlyToDaily(assetCode, bgHours);
                 }
            }
            
            await this.ui.animateCandles(newCandles, 2000);
            
            if (this.ui.isAnimating === false) { 
                await this.data.updateAssetCandles(activeAssetCode, newCandles);
                await this.data.aggregateHourlyToDaily(activeAssetCode, hoursToAdvance);
                await this.data.updateState(SillyViewConfig.world_book_keys.global_market, m => {
                    m.current_time_index = (m.current_time_index || 0) + hoursToAdvance;
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
        const currentTimeframe = this.ui.currentTimeframe;
        const logTimeUnit = currentTimeframe === 'HOURLY' ? '一小时' : '一天';
        Logger.log(`正在推进${logTimeUnit} (AI 模式)...`);
        this.ui.tradeView.updateActionButtonsState(false, true);

        const actionsThisTurn = this.data.getActionsThisTurn();
        const tradedAssetCodes = new Set(actionsThisTurn.map(a => a.assetCode));
        const activeAssetsForAI = new Set([this.ui.currentAsset, ...tradedAssetCodes]);
        
        await this.data.updateAIContext();
        const finalPrompt = await this.aiDirector.buildAdvanceTurnPrompt(actionsThisTurn, activeAssetsForAI, this.ui.currentAsset, currentTimeframe);

        try {
            await this.th.triggerSlash(`/setinput ${JSON.stringify(finalPrompt)}`);
            this.st_context.generate();
        } catch (e) {
            Logger.error("Error triggering AI for next turn:", e);
            this.ui.tradeView.updateActionButtonsState(false, false);
        }
        
        this.data.clearActionsThisTurn();
        this.ui.tradeView.renderThisTurnActions();
        
        await this.data.recordAssetHistory();
        await this.data.saveAllEntries();
        Logger.log("AI回合推进指令已发送。");
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
        
        this.logger.log("正在发送摘要Prompt给AI:", summaryPrompt);

        try {
            await this.th.triggerSlash(`/setinput ${JSON.stringify(summaryPrompt)}`);
            this.st_context.generate();
        } catch (e) {
            this.logger.error("触发AI进行快速模式同步时出错:", e);
        } finally {
            await this.onQuickModeToggled(false);
            this.data.clearActionsThisTurn();
            this.ui.renderAll();
        }
    }
    
    async executeTrade(action, amount, assetCode, executionPrice, leverage) {
        Logger.log(`Executing trade: ${action} ${amount} of ${assetCode} @ ${executionPrice} with ${leverage}x leverage`);

        const success = await this.data.executeAndRecordTrade(action, amount, assetCode, executionPrice, leverage);

        if (success) {
            await this.data.saveAllEntries();
            this.ui.renderAll();
        }
    }


    setupEventListeners() {
        const { eventSource, eventTypes } = this.st_context;
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
