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
        this.initialBootstrapRunning = false;
        this.longTargetExpiryTurnRunning = false;
        this.autoAdvanceTimer = null;
        this.autoAdvanceRunning = false;
        this.autoAdvanceElapsedMinutes = 0;
        this.pendingRoleTurnContext = null;
        this.lastRoleInjectionId = null;

        // Dependencies are set in init() by the main script.js entry point
        this.data = null;
        this.ui = null;
        this.events = null;
        this.commandParser = null;
        this.aiDirector = null;
        this.backgroundAI = null;
        this.roleDecision = null;
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
        this.roleDecision = dependencies.roleDecision;
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

    _getAutoAdvanceSettings() {
        const config = this.data?.getState(SillyViewConfig.world_book_keys.config) || {};
        return {
            enabled: Boolean(config.auto_advance?.enabled),
            minute_interval_ms: 60000,
            minutes_per_turn: 60,
        };
    }

    syncAutoAdvanceFromConfig() {
        const settings = this._getAutoAdvanceSettings();
        if (settings.enabled) this.startAutoAdvanceTimer();
        else this.stopAutoAdvanceTimer();
    }

    startAutoAdvanceTimer() {
        this.stopAutoAdvanceTimer();
        if (!this.data || !this.ui?.isInitialized) return;
        this.autoAdvanceElapsedMinutes = 0;
        this.autoAdvanceTimer = setInterval(() => {
            this._runAutoAdvanceTick().catch(error => this.logger.warn('自动推进分钟K失败:', error));
        }, this._getAutoAdvanceSettings().minute_interval_ms);
        this.logger.log('实时自动推进已开启：每分钟推进一次分K。');
    }

    stopAutoAdvanceTimer() {
        if (this.autoAdvanceTimer) clearInterval(this.autoAdvanceTimer);
        this.autoAdvanceTimer = null;
        this.autoAdvanceElapsedMinutes = 0;
    }

    resetAutoAdvanceTimer(reason = 'manual') {
        this.autoAdvanceElapsedMinutes = 0;
        if (this._getAutoAdvanceSettings().enabled && reason !== 'auto') {
            this.startAutoAdvanceTimer();
        }
    }

    async setAutoAdvanceEnabled(enabled) {
        const nextEnabled = Boolean(enabled);
        await this.data.updateState(SillyViewConfig.world_book_keys.config, config => ({
            ...(config || {}),
            auto_advance: { ...(config?.auto_advance || {}), enabled: nextEnabled },
        }));
        if (nextEnabled) this.startAutoAdvanceTimer();
        else this.stopAutoAdvanceTimer();
        this.dependencies.win.toastr?.info(nextEnabled ? '实时自动推进已开启。' : '实时自动推进已关闭。');
    }

    async _runAutoAdvanceTick() {
        if (this.autoAdvanceRunning || !this._getAutoAdvanceSettings().enabled) return;
        if (this.initialBootstrapRunning || this.longTargetExpiryTurnRunning || this.ui.isAnimating) return;

        this.autoAdvanceRunning = true;
        try {
            const result = await this.advanceMarketMinutes(1, { render: true, source: 'auto' });
            if (result?.autoTurnTriggered) {
                this.resetAutoAdvanceTimer('auto');
                return;
            }
            if (!result?.advanced) return;

            this.autoAdvanceElapsedMinutes += 1;
            if (this.autoAdvanceElapsedMinutes >= this._getAutoAdvanceSettings().minutes_per_turn) {
                this.autoAdvanceElapsedMinutes = 0;
                await this.runAutoHourlyReview();
            }
        } finally {
            this.autoAdvanceRunning = false;
        }
    }

    async _recordImportantEvent(type, assetCode, content, timePoint = null) {
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market) || {};
        await this.data.appendAutoEventLog?.({
            time_index: timePoint?.time_index ?? market.current_time_index,
            minute_time_index: timePoint?.minute_time_index ?? market.minute_time_index,
            datetime: market.current_datetime,
            type,
            asset_code: assetCode,
            content,
        });
    }

    async runAutoHourlyReview() {
        if (this.longTargetExpiryTurnRunning) return;
        const config = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const assetCodes = config.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        if (assetCodes.length === 0) return;

        await this._recordImportantEvent('auto_hourly_review', 'GLOBAL', '自动推进满一小时，后台 AI 开始整点结算。');
        this.dependencies.win.toastr?.info('自动推进满一小时，正在执行后台市场结算。');
        const activeAssetCode = assetCodes.includes(this.ui.currentAsset) ? this.ui.currentAsset : assetCodes[0];
        const prompt = await this.aiDirector.buildAdvanceTurnPrompt([], new Set(assetCodes), activeAssetCode, 'HOURLY', {
            autoReviewOnly: true,
        });
        try {
            const response = await this.backgroundAI.generateMarketResponse(prompt);
            await this.processGeneratedMarketText(response, {
                requiredAssetCodes: [],
                skipLongTargetExpiryAutoTurn: true,
                allowMarketAdvance: false,
            });
            await this.data.accrueFundingFees(1);
            await this.data.accrueManagedAccountFundingFees(1);
            await this.data.recordAssetHistory();
            this.data.clearActionsThisTurn();
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            if (this.ui.isPanelVisible) this.ui.renderAll();
        } catch (error) {
            this.logger.error('自动整点结算失败:', error);
            this.dependencies.win.toastr?.error(`自动整点结算失败: ${error.message || error}`);
            await this._recordImportantEvent('auto_hourly_review_failed', 'GLOBAL', `自动整点结算失败：${error.message || error}`);
        }
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
                    await this._recordImportantEvent('liquidation', assetCode, `强制平仓，触发价 ${Number(currentPrice).toFixed(5)}。`);
                    
                    // Render UI after liquidation
                    this.ui.renderAll();
                    
                    // Stop checking other assets, as the animation will be cancelled.
                    return true;
                }
            }
        }
        return false; // No liquidation occurred
    }

    async _checkRiskControlsForHourlyCandles(assetCode, hourlyCandles, options = {}) {
        if (!Array.isArray(hourlyCandles) || hourlyCandles.length === 0) return false;

        let triggered = false;
        for (const candle of hourlyCandles) {
            const eventTime = options.timeframe === 'MINUTE'
                ? { time_index: Math.floor(Number(candle.time || 0) / 60), minute_time_index: Number(candle.time || 0) }
                : { time_index: Number(candle.time || 0), minute_time_index: Number(candle.time || 0) * 60 };
            const accountResult = await this.data.processManagedAccountRiskForCandle(assetCode, candle);
            if (accountResult?.triggered) {
                triggered = true;
                for (const event of accountResult.events || []) {
                    const content = `托管账户 ${event.account_id || '未知'} ${event.mode === 'spot' ? '现货' : '杠杆'}${event.label}，触发价 ${Number(event.price || 0).toFixed(5)}。`;
                    this.dependencies.win.toastr.warning(content, '自动风控');
                    await this._recordImportantEvent(event.type, assetCode, content, eventTime);
                }
            }

            const result = await this.data.triggerRiskControlsForCandle(assetCode, candle);
            if (result?.triggered) {
                triggered = true;
                for (const event of result.events || [result]) {
                    const modeLabel = event.mode === 'spot' ? '现货' : '杠杆';
                    await this._recordImportantEvent(event.triggerType, assetCode, `${modeLabel}${event.triggerType === 'take_profit' ? '止盈' : event.triggerType === 'stop_loss' ? '止损' : '强制平仓'}触发，成交价 ${Number(event.price || 0).toFixed(5)}。`, eventTime);
                }
                if (result.triggerType === 'liquidation') break;
                const triggerCandle = result.triggerCandle;
                const rangeText = triggerCandle
                    ? `（K线 H ${triggerCandle.high.toFixed(5)} / L ${triggerCandle.low.toFixed(5)}）`
                    : '';
                this.dependencies.win.toastr.info(
                    `${assetCode} ${result.triggerType === 'take_profit' ? '止盈' : '止损'}触发，成交价 ${result.price.toFixed(5)} ${rangeText}。`
                );
                break;
            }
        }

        if (triggered) {
            this.ui.renderAll();
        }
        return triggered;
    }

    _collectExpiredLongTargetsForAutoTurn(assetCodes = null) {
        const targetState = this.data.getMarketTargets?.() || {};
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market) || {};
        const currentTimeIndex = Number(market.current_time_index || 0);
        const selected = assetCodes ? new Set([...assetCodes].filter(Boolean)) : null;
        const expiredTargets = [];

        for (const assetCode of Object.keys(targetState.targets || {})) {
            if (selected && !selected.has(assetCode)) continue;
            const longTarget = targetState.targets[assetCode]?.long;
            if (!longTarget) continue;

            const endTime = Number(longTarget.end_time);
            if (!Number.isFinite(endTime) || endTime > currentTimeIndex) continue;

            expiredTargets.push({
                assetCode,
                assetName: SillyViewConfig.asset_definitions[assetCode]?.name || assetCode,
                target_price: Number(longTarget.target_price || 0),
                start_price: Number(longTarget.start_price || 0),
                created_at: Number(longTarget.created_at || 0),
                end_time: endTime,
                pattern: longTarget.pattern || 'unknown',
                reason: longTarget.reason || '',
                confidence: Number(longTarget.confidence ?? 0),
                current_time_index: currentTimeIndex,
            });
        }

        return expiredTargets;
    }

    _getHoursUntilNextLongTargetExpiry(maxHours) {
        const limit = Math.max(0, Math.floor(Number(maxHours) || 0));
        if (limit <= 0) return 0;

        const targetState = this.data.getMarketTargets?.() || {};
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market) || {};
        const currentTimeIndex = Number(market.current_time_index || 0);
        let hoursUntilExpiry = limit;

        for (const assetTargets of Object.values(targetState.targets || {})) {
            const endTime = Number(assetTargets?.long?.end_time);
            if (!Number.isFinite(endTime) || endTime <= currentTimeIndex) continue;
            hoursUntilExpiry = Math.min(hoursUntilExpiry, Math.max(1, Math.ceil(endTime - currentTimeIndex)));
        }

        return hoursUntilExpiry;
    }

    _portfolioHasAssetPosition(portfolio, assetCode) {
        const asset = portfolio?.assets?.[assetCode] || {};
        return ['spot', 'leveraged'].some(mode => (asset[mode]?.trades || []).length > 0)
            || (asset.trades || []).length > 0;
    }

    async _getActiveAssetsForAutoTurn(expiredTargets = []) {
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const availableAssets = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        const availableSet = new Set(availableAssets);
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const openPositionCodes = Object.keys(portfolio.assets || {})
            .filter(assetCode => this._portfolioHasAssetPosition(portfolio, assetCode));
        const managedAccountAssetCodes = await this.data.getManagedAccountOpenAssetCodes() || [];
        const activeAssets = new Set([
            ...availableAssets,
            this.ui.currentAsset,
            ...expiredTargets.map(item => item.assetCode),
            ...openPositionCodes,
            ...managedAccountAssetCodes,
        ].filter(assetCode => availableSet.has(assetCode)));

        if (activeAssets.size === 0 && availableAssets.length > 0) {
            activeAssets.add(availableAssets[0]);
        }

        return activeAssets;
    }

    async triggerLongTargetExpiryTurnIfNeeded(options = {}) {
        if (this.longTargetExpiryTurnRunning || options.skipLongTargetExpiryAutoTurn) return false;

        const expiredTargets = options.expiredLongTargets || this._collectExpiredLongTargetsForAutoTurn(options.assetCodes || null);
        if (!expiredTargets || expiredTargets.length === 0) return false;

        this.longTargetExpiryTurnRunning = true;
        this.ui.tradeView?.updateActionButtonsState(false, true);

        try {
            if (this.data.isQuickModeEnabled()) {
                await this.onQuickModeToggled(false);
            }

            const activeAssetsForAI = await this._getActiveAssetsForAutoTurn(expiredTargets);
            const activeAssetCode = expiredTargets.find(item => activeAssetsForAI.has(item.assetCode))?.assetCode
                || this.ui.currentAsset
                || [...activeAssetsForAI][0];

            this.logger.log(`长线目标到期，自动发送一次后台AI结束回合请求: ${expiredTargets.map(item => item.assetCode).join(', ')}`);
            await this._recordImportantEvent('long_target_expired', 'GLOBAL', `长线目标到期：${expiredTargets.map(item => item.assetCode).join(', ')}，自动触发后台 AI 结算。`);
            this.dependencies.win.toastr?.info('长线目标已到期，正在自动请求后台 AI 结算并设定下一段行情。');

            const prompt = await this.aiDirector.buildAdvanceTurnPrompt([], activeAssetsForAI, activeAssetCode, 'HOURLY', {
                expiredLongTargets: expiredTargets,
                autoTriggerReason: 'long_target_expired',
            });
            const marketResponse = await this.backgroundAI.generateMarketResponse(prompt);

            await this.processGeneratedMarketText(marketResponse, {
                requiredAssetCodes: [...activeAssetsForAI],
                skipLongTargetExpiryAutoTurn: true,
            });

            this.data.clearActionsThisTurn();
            await this.data.accrueFundingFees(1);
            await this.data.accrueManagedAccountFundingFees(1);
            await this.data.recordAssetHistory();
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            if (this.ui.isPanelVisible) this.ui.renderAll();
            this.logger.success('长线目标到期自动回合完成。');
            this.resetAutoAdvanceTimer('auto');
            return true;
        } catch (error) {
            this.logger.error('长线目标到期自动回合失败。', error);
            this.dependencies.win.toastr?.error(`长线目标到期自动回合失败: ${error.message || error}`);
            return false;
        } finally {
            this.longTargetExpiryTurnRunning = false;
            this.ui.tradeView?.updateActionButtonsState(false, false);
        }
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

    async prepareRoleObservation(firstPassText) {
        const commands = this.commandParser.parse(firstPassText);
        const session = await this.data.beginManagedObservationSession(commands);
        return {
            ...session,
            first_pass_text: firstPassText,
            second_request_context: session.active
                ? `【角色首次判断】\n${firstPassText}\n\n【本次观察数据】\n${session.context}`
                : '',
        };
    }

    async finishRoleObservation(sessionId = null, options = {}) {
        return await this.data.endManagedObservationSession(sessionId, options);
    }

    captureRoleTurnForUserMessage(messageId) {
        if (!this.roleDecision?.isEnabled() && !this.roleDecision?.isDebugEnabled()) return;
        const context = this.roleDecision.captureTurnContext(messageId);
        if (!context) return;
        if (this.roleDecision.isEnabled()) this.pendingRoleTurnContext = context;
        this.events?.refreshRoleDebugWindow?.();
    }

    async prepareFrontendRoleInjection(type, option = {}, dryRun = false) {
        if (dryRun || !this.pendingRoleTurnContext || !this.roleDecision?.isEnabled()) return;
        if (option?.automatic_trigger || !['normal', 'continue', undefined, null].includes(type)) return;
        const context = this.pendingRoleTurnContext;
        this.pendingRoleTurnContext = null;

        try {
            const result = await this.roleDecision.run(context);
            if (!result?.frontend_injection) return;
            if (!this.th?.injectPrompts) throw new Error('TavernHelper.injectPrompts 不可用。');
            const injectionId = `sillyview-role-context-${context.user_message_id}-${Date.now()}`;
            this.th.injectPrompts([{
                id: injectionId,
                position: 'in_chat',
                depth: 0,
                role: 'system',
                content: result.frontend_injection,
                should_scan: false,
            }], { once: true });
            this.lastRoleInjectionId = injectionId;
            this.logger.success(`角色决策已注入本次前台生成: message ${context.user_message_id}`);
        } catch (error) {
            this.logger.error('角色决策流程失败，前台生成将继续但不注入角色决策。', error);
            this.dependencies.win.toastr?.warning(`角色决策流程失败: ${error.message || error}`);
        }
    }

    async processGeneratedMarketText(msg, options = {}) {
        const requiredAssetCodes = options.requiredAssetCodes || [];
        const silent = options.silent === true;

        const commands = this.commandParser.parse(msg);
        let hasAdvanced = false;
        let hasUpdatedFinancials = false;
        let hasUpdatedTimeline = false;
        let hasUpdatedTargets = false;
        let hasUpdatedNews = false;
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
                if (options.allowMarketAdvance === false) continue;
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
                if (options.allowMarketAdvance === false) continue;
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
                if (options.allowTimeAdvance === false) continue;
                const [time, period, season, weather] = command.args;
                if (typeof time === 'string' && typeof period === 'string') {
                    await this.data.setWorldTime({ time, period, season, weather });
                    hasUpdatedTimeline = true;
                } else {
                    Logger.warn('收到了格式不正确的 Time.Set 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Market' && command.type === 'AddNews') {
                const [assetCode = 'GLOBAL', headline, durationHours] = command.args;
                if (
                    typeof headline === 'string' && headline.trim() &&
                    typeof durationHours === 'number' && durationHours > 0 &&
                    (assetCode === 'GLOBAL' || SillyViewConfig.asset_definitions[assetCode])
                ) {
                    hasUpdatedNews = Boolean(await this.data.recordMarketNews(headline, assetCode, durationHours)) || hasUpdatedNews;
                } else {
                    Logger.warn('收到了格式不正确的 Market.AddNews 指令，已忽略:', command.args);
                }
            }
            else if (command.module === 'Trade') {
                const ok = await this.data.processManagedAccountTradeCommand(command);
                if (ok) {
                    hasUpdatedFinancials = true;
                } else {
                    Logger.warn('收到了无法执行的 Trade 指令，已忽略:', command.args);
                }
            }
            
            if (newCandles && newCandles.length > 0 && assetCodeForUpdate) {
                const minuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCodeForUpdate, newCandles);
                if (silent) {
                    await this.data.updateAssetCandles(assetCodeForUpdate, newCandles, minuteCandles);
                    const assetDef = SillyViewConfig.asset_definitions[assetCodeForUpdate];
                    if (assetDef) await this.data.aggregateHourlyToDaily(assetCodeForUpdate, assetDef.trading_hours_per_day);
                    const newTimeIndex = newCandles.slice(-1)[0].time;
                    const newMinuteIndex = minuteCandles.length > 0 ? minuteCandles[minuteCandles.length - 1].time : newTimeIndex * 60;
                    await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
                        market.current_time_index = Math.max(market.current_time_index || 0, newTimeIndex);
                        market.minute_time_index = Math.max(market.minute_time_index || 0, newMinuteIndex);
                        return market;
                    });
                } else {
                    await this.ui.handleAiResponse(newCandles, msg, assetCodeForUpdate, minuteCandles);
                }
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
            if (!silent) this.ui.renderAll();
        }

        if (maxAdvancedTimeIndex > 0 && !hasUpdatedNews) {
            await this._recordHeadlineOnce(msg, maxAdvancedTimeIndex, [...headlineAssetCodes]);
        }

        const expiredLongTargetsForAutoTurn = (!silent && !options.skipLongTargetExpiryAutoTurn)
            ? this._collectExpiredLongTargetsForAutoTurn()
            : [];
        await this.data.pruneExpiredMarketTargets();

        if (hasUpdatedFinancials || hasUpdatedTimeline || hasUpdatedTargets || hasUpdatedNews) {
            if (!silent) this.ui.renderAll();
        } else if (!hasAdvanced) {
            // If no commands were processed, ensure buttons are re-enabled
            if (!silent) this.ui.tradeView.updateActionButtonsState(false, false);
        }
        
        await this.data.updateAIContext();
        await this.data.saveAllEntries();

        if (expiredLongTargetsForAutoTurn.length > 0) {
            await this.triggerLongTargetExpiryTurnIfNeeded({
                expiredLongTargets: expiredLongTargetsForAutoTurn,
            });
        }
    }

    _extractHeadline(msg) {
        const headlineMatch = String(msg || '').match(/<headline>([\s\S]*?)<\/headline>/i);
        return headlineMatch?.[1]?.replace(/\s+/g, ' ').trim() || '';
    }

    async _recordHeadlineOnce(msg, timeIndex, assetCodes = []) {
        const headline = this._extractHeadline(msg);
        if (!headline) return;

        const uniqueAssetCodes = [...new Set(assetCodes)].filter(Boolean);
        const assetCode = uniqueAssetCodes.length === 1 ? uniqueAssetCodes[0] : 'GLOBAL';
        await this.data.recordMarketNews(headline, assetCode, 6, timeIndex);
    }
    
    async onQuickModeToggled(isEnabled) {
        this.resetAutoAdvanceTimer('manual_quick_mode');
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

    async _advanceInitializationQuickDay() {
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const assetCodes = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        if (assetCodes.length === 0) return;
        const maxHours = Math.max(...assetCodes.map(assetCode => SillyViewConfig.asset_definitions[assetCode]?.trading_hours_per_day || 24));
        let maxTimeIndex = 0;

        await this.marketSimulator.advanceMarketRegime(maxHours);
        await this.marketSimulator.advanceMacroState(maxHours);

        for (const assetCode of assetCodes) {
            const assetDef = SillyViewConfig.asset_definitions[assetCode];
            if (!assetDef) continue;

            const hours = assetDef.trading_hours_per_day || 24;
            const hourlyCandles = this.marketSimulator.calculateCandlesForQuickMode(assetCode, hours);
            const minuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCode, hourlyCandles);
            await this.data.updateAssetCandles(assetCode, hourlyCandles, minuteCandles);
            await this.data.aggregateHourlyToDaily(assetCode, hours);
            await this._checkRiskControlsForHourlyCandles(assetCode, hourlyCandles);
            if (hourlyCandles.length > 0) {
                maxTimeIndex = Math.max(maxTimeIndex, hourlyCandles[hourlyCandles.length - 1].time || 0);
            }
        }

        if (maxTimeIndex > 0) {
            await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
                market.current_time_index = Math.max(market.current_time_index || 0, maxTimeIndex);
                market.minute_time_index = Math.max(market.minute_time_index || 0, maxTimeIndex * 60);
                return market;
            });
        }

        await this._checkLiquidations();
        await this.data.accrueFundingFees(24);
        await this.data.accrueManagedAccountFundingFees(24);
        await this.data.recordAssetHistory();
        await this.data.updateAIContext();
        await this.data.saveAllEntries();
    }

    async runInitialBootstrapTurn() {
        if (this.initialBootstrapRunning) return;
        this.initialBootstrapRunning = true;

        try {
            this.ui.renderInitializationProgress({
                step: '预热',
                title: '正在快速推进一天',
                detail: '正在为全部资产生成首日 K线、资金费率和账户曲线。',
                percent: 65,
            });
            this.logger.log('初始化预热：开始静默快速推进一天。');
            await this._advanceInitializationQuickDay();

            const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
            const assetCodes = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
            if (assetCodes.length === 0) {
                this.logger.warn('初始化预热跳过：没有可用资产。');
                return;
            }
            const activeAssetCode = assetCodes.includes(this.ui.currentAsset) ? this.ui.currentAsset : (assetCodes[0] || 'EURUSD');
            const actionsThisTurn = this.data.getActionsThisTurn();

            this.ui.renderInitializationProgress({
                step: '后台 AI',
                title: '正在等待后台 AI',
                detail: '已完成首日市场预热，正在发送回合结束提示词生成新闻、目标和下一段行情。',
                percent: 76,
            });
            this.logger.log('初始化预热：正在发送一次后台AI结束回合提示词。');
            const prompt = await this.aiDirector.buildAdvanceTurnPrompt(actionsThisTurn, new Set(assetCodes), activeAssetCode, 'DAILY');
            const marketResponse = await this.backgroundAI.generateMarketResponse(prompt);
            this.ui.renderInitializationProgress({
                step: '处理',
                title: '正在处理 AI 返回',
                detail: '正在解析市场指令、新闻、多账户交易指令并写回世界书。',
                percent: 88,
            });
            await this.processGeneratedMarketText(marketResponse, {
                requiredAssetCodes: assetCodes,
                silent: true,
            });

            this.data.clearActionsThisTurn();
            await this.data.accrueFundingFees(24);
            await this.data.accrueManagedAccountFundingFees(24);
            await this.data.recordAssetHistory();
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            this.logger.success('初始化预热完成。');
        } finally {
            this.initialBootstrapRunning = false;
        }
    }
    
    async advanceQuickModeHour() {
        this.resetAutoAdvanceTimer('manual_quick_hour');
        if (!this.data.isQuickModeEnabled() || this.ui.isAnimating) return;

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
            return m;
        });

        const activeAssetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${activeAssetCode}`);
        const candlesToAnimate = this.ui.currentTimeframe === 'MINUTE'
            ? activeMinuteCandles
            : activeAssetData.kline_hourly.slice(-1);
        await this.ui.animateCandles(candlesToAnimate, 1000); 
        
        await this._checkLiquidations();
        await this.data.accrueFundingFees(1);
        await this.data.accrueManagedAccountFundingFees(1);
        await this.data.recordAssetHistory();
        if (await this.triggerLongTargetExpiryTurnIfNeeded()) return;
        await this.data.updateAIContext();
        await this.data.saveAllEntries();
        
        this.ui.renderAll(); 
        Logger.log(`快速模式: 推进 1 小时完成。`);
    }

    async commitAndAdvance(options = {}) {
        if (options.source !== 'auto') this.resetAutoAdvanceTimer('manual_end_turn');
        if (this.ui.isAnimating) return;
        
        const isQuickMode = this.data.isQuickModeEnabled();

        if (isQuickMode) {
            if (await this.triggerLongTargetExpiryTurnIfNeeded()) return;

            const activeAssetCode = this.ui.currentAsset;
            const assetDef = SillyViewConfig.asset_definitions[activeAssetCode];
            const requestedHours = assetDef.trading_hours_per_day;
            const hoursToAdvance = this._getHoursUntilNextLongTargetExpiry(requestedHours);
            
            if (hoursToAdvance < requestedHours) {
                this.dependencies.win.toastr.info(`长线目标即将到期，本次快速推进在 ${hoursToAdvance} 小时处结束。`);
            }
    
            await this.marketSimulator.advanceMarketRegime(hoursToAdvance);
            await this.marketSimulator.advanceMacroState(hoursToAdvance);
            const newCandles = this.marketSimulator.calculateCandlesForQuickMode(activeAssetCode, hoursToAdvance);
            const activeMinuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(activeAssetCode, newCandles);
            
            for (const assetCode of Object.keys(SillyViewConfig.asset_definitions)) {
                 if (assetCode !== activeAssetCode) {
                    const bgCandles = this.marketSimulator.calculateCandlesForBackgroundAsset(assetCode, hoursToAdvance);
                    const bgMinuteCandles = this.marketSimulator.calculateMinuteCandlesForHourlyCandles(assetCode, bgCandles);
                    await this.data.updateAssetCandles(assetCode, bgCandles, bgMinuteCandles);
                    await this.data.aggregateHourlyToDaily(assetCode, hoursToAdvance);
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
                    return m;
                });
                this.data.clearActionsThisTurn();
                await this.data.accrueFundingFees(hoursToAdvance);
                await this.data.accrueManagedAccountFundingFees(hoursToAdvance);
                await this.data.recordAssetHistory();
                if (await this.triggerLongTargetExpiryTurnIfNeeded()) return;
                await this.data.updateAIContext();
                this.ui.renderAll();
            }
            return;
        }

        // AI Mode
        const currentTimeframe = this.ui.currentTimeframe === 'MINUTE' ? 'HOURLY' : this.ui.currentTimeframe;
        const logTimeUnit = currentTimeframe === 'HOURLY' ? '一小时' : '一天';
        await this.data.accrueInterest();
        Logger.log(`正在推进${logTimeUnit} (AI 模式)...`);
        this.ui.tradeView.updateActionButtonsState(false, true);

        const actionsThisTurn = this.data.getActionsThisTurn();
        const tradedAssetCodes = new Set(actionsThisTurn.map(a => a.assetCode));
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const openPositionCodes = Object.keys(portfolio.assets || {})
            .filter(assetCode => this._portfolioHasAssetPosition(portfolio, assetCode));
        const managedAccountAssetCodes = await this.data.getManagedAccountOpenAssetCodes();
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const availableAssets = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        const activeAssetsForAI = new Set([
            ...availableAssets,
            this.ui.currentAsset,
            ...tradedAssetCodes,
            ...openPositionCodes,
            ...managedAccountAssetCodes,
        ]);
        
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

            await this.data.accrueFundingFees(currentTimeframe === 'DAILY' ? 24 : 1);
            await this.data.accrueManagedAccountFundingFees(currentTimeframe === 'DAILY' ? 24 : 1);
            await this.data.recordAssetHistory();
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            Logger.log("AI回合后台推进完成。");
        } finally {
            this.ui.tradeView.updateActionButtonsState(false, false);
        }
    }
    
    async syncQuickModeWithAI() {
        this.resetAutoAdvanceTimer('manual_quick_sync');
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
    
    async executeTrade(action, amount, assetCode, executionPrice, leverage, riskControls = null, mode = 'leveraged') {
        Logger.log(`Executing ${mode} trade: ${action} ${amount} of ${assetCode} @ ${executionPrice} with ${leverage}x leverage`);

        const success = await this.data.executeAndRecordTrade(action, amount, assetCode, executionPrice, leverage, riskControls, mode);

        if (success) {
            await this.data.updateAIContext();
            await this.data.saveAllEntries();
            this.ui.renderAll();
        }
    }

    async advanceMinutesForUserMessage(msgId) {
        if (this._getAutoAdvanceSettings().enabled) return;
        if (this.lastMinuteAdvanceMessageId === msgId) return;

        const messages = this.th.getChatMessages(msgId);
        if (!messages || messages.length === 0 || !messages[0].is_user) return;
        this.lastMinuteAdvanceMessageId = msgId;

        const loaded = await this.data.ensureStateLoaded();
        if (!loaded) return;

        this.resetAutoAdvanceTimer('dialogue_minute');
        const barsToAdvance = Math.floor(Math.random() * 2) + 1;
        await this.advanceMarketMinutes(barsToAdvance, { render: true });
    }

    async advanceQuickModeMinutes(minutes = 5) {
        this.resetAutoAdvanceTimer('manual_quick_minutes');
        if (!this.data.isQuickModeEnabled() || this.ui.isAnimating) return;
        const barsToAdvance = Math.max(1, Math.floor(Number(minutes) || 1));
        Logger.log(`快速模式: 推进 ${barsToAdvance} 分钟...`);
        await this.advanceMarketMinutes(barsToAdvance, { render: true });
        Logger.log(`快速模式: 推进 ${barsToAdvance} 分钟完成。`);
    }

    async advanceMarketMinutes(barsToAdvance = 1, options = {}) {
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        const assetCodes = configState.available_assets || Object.keys(SillyViewConfig.asset_definitions);
        let maxMinuteTime = 0;

        for (const assetCode of assetCodes) {
            const minuteCandles = this.marketSimulator.calculateMinuteCandlesForUserInput(assetCode, barsToAdvance);
            if (minuteCandles.length === 0) continue;

            await this.data.appendMinuteCandles(assetCode, minuteCandles);
            await this._syncHourlyFromMinuteBoundary(assetCode, minuteCandles);
            maxMinuteTime = Math.max(maxMinuteTime, minuteCandles[minuteCandles.length - 1].time);
            await this._checkRiskControlsForHourlyCandles(assetCode, minuteCandles, { timeframe: 'MINUTE' });
        }

        if (maxMinuteTime > 0) {
            await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
                market.minute_time_index = Math.max(market.minute_time_index || 0, maxMinuteTime);
                market.current_time_index = Math.max(market.current_time_index || 0, Math.floor(maxMinuteTime / 60));
                return market;
            });

            await this._checkLiquidations();
            if (await this.triggerLongTargetExpiryTurnIfNeeded()) {
                return { advanced: true, autoTurnTriggered: true };
            }
            await this.data.updateAIContext();
            await this.data.saveAllEntries();

            if (options.render !== false && this.ui.isPanelVisible) {
                this.ui.renderAll();
            }
            return { advanced: true, autoTurnTriggered: false };
        }
        return { advanced: false, autoTurnTriggered: false };
    }

    async _syncHourlyFromMinuteBoundary(assetCode, minuteCandles) {
        if (!Array.isArray(minuteCandles) || minuteCandles.length === 0) return;

        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
        const hourly = assetData?.kline_hourly || [];
        const minute = assetData?.kline_minute || [];
        const lastHourlyTime = hourly[hourly.length - 1]?.time ?? 0;
        const newHourlyCandles = [];

        for (const candle of minuteCandles) {
            if (candle.time <= 0 || candle.time % 60 !== 0) continue;
            const hour = candle.time / 60;
            if (hour <= lastHourlyTime || newHourlyCandles.some(item => item.time === hour)) continue;
            const hourMinutes = minute.filter(item => item.time > (hour - 1) * 60 && item.time <= hour * 60);
            if (hourMinutes.length === 0) continue;
            newHourlyCandles.push({
                time: hour,
                open: hourMinutes[0].open,
                high: Math.max(...hourMinutes.map(item => Number(item.high || item.close || 0))),
                low: Math.min(...hourMinutes.map(item => Number(item.low || item.close || Infinity))),
                close: hourMinutes[hourMinutes.length - 1].close,
                volume: hourMinutes.reduce((sum, item) => sum + Number(item.volume || 0), 0),
                pattern: `minute_sync_${hourMinutes[hourMinutes.length - 1].pattern || 'mixed'}`,
            });
        }

        if (newHourlyCandles.length === 0) return;

        await this.data.updateAssetCandles(assetCode, newHourlyCandles, []);
        const assetDef = SillyViewConfig.asset_definitions[assetCode];
        if (assetDef) await this.data.aggregateHourlyToDaily(assetCode, assetDef.trading_hours_per_day);
        await this._checkRiskControlsForHourlyCandles(assetCode, newHourlyCandles);
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
                this.captureRoleTurnForUserMessage(id);
                setTimeout(() => {
                    this.advanceMinutesForUserMessage(id).catch(error => {
                        this.logger.warn('Failed to advance minute candles for user message:', error);
                    });
                }, 100);
            });
        }
        if (eventTypes.GENERATION_AFTER_COMMANDS) {
            eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, async (type, option, dryRun) => {
                await this.prepareFrontendRoleInjection(type, option, dryRun);
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
            this.pendingRoleTurnContext = null;
            this.stopAutoAdvanceTimer();
            if (this.ui.isPanelVisible) {
                this.data.loadInitialState();
            }
        });
    }
}
