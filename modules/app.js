/**
 * SillyView - Main Application Class (v5 - Active Asset Refactor)
 * Orchestrates all modules and handles the core application lifecycle and state management.
 */
'use strict';

import { Logger } from './logger.js';
import { SillyViewConfig } from './config.js';
import { DataManager } from './dataManager.js';
import { UIRenderer } from './uiRenderer.js';
import { EventHandler } from './eventHandler.js';
import { CommandParser } from './commandParser.js';

export class SillyViewApp {
    constructor() {
        // Core SillyTavern APIs
        this.parentWin = window.parent;
        this.st = this.parentWin.SillyTavern;
        this.th = this.parentWin.TavernHelper;
        this.st_context = this.st.getContext();

        // App state and modules
        this.processorTimeout = null;
        this.previousStateSnapshot = null;
        this.quickModeStartState = null;

        // Base dependencies that don't depend on other modules
        const baseDependencies = {
            app: this,
            win: this.parentWin,
            parentDoc: this.parentWin.document,
            st: this.st,
            th: this.th,
            st_context: this.st_context,
            logger: Logger,
            config: SillyViewConfig,
            commandParser: CommandParser,
        };

        // Instantiate modules
        this.data = new DataManager(baseDependencies);
        this.ui = new UIRenderer({ ...baseDependencies, data: this.data });
        this.events = new EventHandler({ ...baseDependencies, data: this.data, ui: this.ui });

        // CRITICAL: Inject dependencies that create cycles *after* all modules are instantiated.
        this.data.ui = this.ui;
        this.ui.dependencies.events = this.events;

        Logger.log("SillyViewApp constructed with dependencies injected.");
    }

    async init() {
        Logger.log("SillyViewApp initializing...");
        await this.ui.loadPanelHtml();
        this.events.bindInitialEvents();
        this.setupEventListeners();
        Logger.success("SillyViewApp initialization complete.");
    }

    debouncedMainProcessor(msgId, isReprocessing = false) {
        clearTimeout(this.processorTimeout);
        this.processorTimeout = setTimeout(async () => {
            Logger.log(`[Processor] Running for ID: ${msgId}. Is Reprocessing: ${isReprocessing}`);

            if (isReprocessing && this.previousStateSnapshot) {
                Logger.log('Edit/Swipe detected. Rolling back to previous state snapshot.');
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

        const lastTimeIndex = await this.ui.handleAiResponse(msg);

        // After the active asset is handled by AI, we clear the actions for the turn
        if (lastTimeIndex !== null) {
            this.data.clearActionsThisTurn();
            this.ui.renderThisTurnActions();
        }
        
        await this.data.saveAllEntries();
    }

    async onQuickModeToggled(isEnabled) {
        await this.data.setQuickModeEnabled(isEnabled);
        if (isEnabled) {
            // Save a full snapshot of the current state
            this.quickModeStartState = this.data.createSnapshot();
            Logger.log("快速模式已启用，状态快照已创建。");
        } else {
            this.quickModeStartState = null;
            Logger.log("快速模式已手动禁用。");
        }
        this.ui.updateUIVisibility();
    }

    async commitAndAdvance() {
        Logger.log("正在推进一天...");
        const activeAssetCode = this.ui.currentAsset;
        const allAssetCodes = Object.keys(SillyViewConfig.asset_definitions);
        const isQuickMode = this.data.isQuickModeEnabled();

        // 1. Determine all "active" assets (currently viewed + traded this turn)
        const actionsThisTurn = this.data.getActionsThisTurn();
        const tradedAssetCodes = new Set(actionsThisTurn.map(a => a.assetCode));
        const activeAssets = new Set([activeAssetCode, ...tradedAssetCodes]);

        // 2. Handle all assets that are NOT the currently viewed one in the background
        for (const assetCode of allAssetCodes) {
            if (assetCode === activeAssetCode) continue; // Skip the one we're looking at

            const assetDef = SillyViewConfig.asset_definitions[assetCode];
            const hoursToSimulate = assetDef.trading_hours_per_day;
            await this.data.advanceAssetInBackground(assetCode, hoursToSimulate);
            await this.data.aggregateHourlyToDaily(assetCode, hoursToSimulate);
        }

        // 3. Handle the ACTIVE and CURRENTLY VIEWED asset
        const activeAssetDef = SillyViewConfig.asset_definitions[activeAssetCode];
        const hoursToAdvance = activeAssetDef.trading_hours_per_day;

        if (isQuickMode) {
            Logger.log(`快速模式: 为 ${activeAssetCode} 推进 ${hoursToAdvance} 小时。`);
            await this.ui.advanceDayQuickMode(hoursToAdvance);
            this.data.clearActionsThisTurn();
            this.ui.renderThisTurnActions();
        } else {
            // AI Mode - Build the new complex prompt
            const playerActionsString = actionsThisTurn.map(a => {
                const type = a.type === 'buy' ? '买入' : '卖出';
                const assetName = SillyViewConfig.asset_definitions[a.assetCode]?.name || a.assetCode;
                return `${type} ${a.amount} 信用点的 ${assetName}`;
            }).join('； ');

            let contextString = '<context>\n';
            for (const code of activeAssets) {
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${code}`);
                const assetDef = SillyViewConfig.asset_definitions[code];
                if (assetData && assetDef) {
                    contextString += `- ${assetDef.name} (${code}): 最新价格 ${assetData.current_price.toFixed(4)} 信用点\n`;
                }
            }
            const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
            contextString += `- 玩家现金: ${portfolio.cash.toFixed(2)} 信用点\n`;
            contextString += '</context>';

            const timeUnit = `一${activeAssetDef.trading_hours_per_day === 24 ? '整天' : '个交易日'}`;
            const activeAssetNames = Array.from(activeAssets).map(code => SillyViewConfig.asset_definitions[code]?.name || code).join('、');
            const currentAssetName = SillyViewConfig.asset_definitions[activeAssetCode]?.name || activeAssetCode;
            
            let finalPrompt = `时间过去了${timeUnit}，{{user}}进行了以下操作：\n${playerActionsString || '无操作。'}\n\n${contextString}\n\n请根据以上信息，为 ${activeAssetNames} 生成接下来的市场动态和新闻。对于当前正在查看的 ${currentAssetName}，请使用 [Market.Advance(收盘价, "模式")] 指令来决定其收盘价和走势。`;

            try {
                // The AI response will be picked up by the processSingleMessage listener, which then calls ui.handleAiResponse
                await this.dependencies.th.triggerSlash(`/setinput ${JSON.stringify(finalPrompt)}`);
                this.dependencies.st_context.generate();
            } catch (e) {
                Logger.error("Error triggering AI for next day:", e);
            }
        }
        // Actions are cleared after AI responds (in processSingleMessage) or after quick mode advances.
        await this.data.saveAllEntries();
        Logger.log("一天推进完成。");
    }

    async syncQuickModeWithAI() {
        if (!this.quickModeStartState) {
            Logger.warn("尝试同步，但快速模式未激活或起始状态丢失。");
            return;
        }

        Logger.log("正在将快速模式结果与AI同步...");
        await this.onQuickModeToggled(false); // Disable quick mode

        const startPortfolio = this.quickModeStartState.get(SillyViewConfig.world_book_keys.player_portfolio);
        const endPortfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        const startMarket = this.quickModeStartState.get(SillyViewConfig.world_book_keys.global_market);
        const endMarket = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        
        const startValue = startPortfolio.cash; // Simplified for now, needs portfolio calculation
        const endValue = endPortfolio.cash;
        const profitLoss = endValue - startValue;
        const timeUnitsAdvanced = endMarket.current_time_index - startMarket.current_time_index;

        const playerActionsString = (startPortfolio.actions_this_turn || []).map(a => {
            const type = a.type === 'buy' ? '买入' : '卖出';
            const assetName = SillyViewConfig.asset_definitions[a.assetCode]?.name || a.assetCode;
            return `${type} ${a.amount} 信用点的 ${assetName}`;
        }).join('； ');
        
        const profitLossString = `他的盈亏是: ${profitLoss.toFixed(2)} 信用点`;
        
        const marketChanges = [];
        for (const assetCode of Object.keys(SillyViewConfig.asset_definitions)) {
            const startAssetData = this.quickModeStartState.get(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
            const endAssetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
            if (startAssetData && endAssetData && startAssetData.current_price > 0) {
                const startPrice = startAssetData.current_price;
                const endPrice = endAssetData.current_price;
                const change = endPrice - startPrice;
                const percentChange = (change / startPrice) * 100;
                if (Math.abs(percentChange) > 0.01) { // Only report significant changes
                    const direction = change > 0 ? '上涨' : '下跌';
                    const assetName = SillyViewConfig.asset_definitions[assetCode]?.name || assetCode;
                    marketChanges.push(`${assetName} ${direction} ${Math.abs(percentChange).toFixed(2)}%`);
                }
            }
        }
        const marketChangesString = `市场的变化是: ${marketChanges.join('，') || '无显著变化'}`;

        const summaryPrompt = `时间过去了${timeUnitsAdvanced}小时, {{user}}进行了以下操作：\n${playerActionsString || '无操作。'}\n${profitLossString}\n${marketChangesString}\n\n请根据以上摘要，生成一段承上启下的市场总结和评论。`;
        
        Logger.log("正在发送摘要Prompt给AI:", summaryPrompt);

        try {
            await this.dependencies.th.triggerSlash(`/setinput ${JSON.stringify(summaryPrompt)}`);
            this.dependencies.st_context.generate();
        } catch (e) {
            Logger.error("触发AI进行快速模式同步时出错:", e);
        }

        this.quickModeStartState = null; // Clear snapshot after use
    }

    setupEventListeners() {
        const { eventSource, eventTypes } = this.st_context;

        eventSource.on(eventTypes.MESSAGE_RECEIVED, (id) => this.debouncedMainProcessor(id, false));
        eventSource.on(eventTypes.MESSAGE_EDITED, (id) => this.debouncedMainProcessor(id, true));
        eventSource.on(eventTypes.MESSAGE_SWIPED, (id) => this.debouncedMainProcessor(id, true));

        eventSource.on(eventTypes.MESSAGE_DELETED, async (id) => {
            const lastMessageId = await this.th.getLastMessageId();
            if (id === lastMessageId + 1 && this.previousStateSnapshot) {
                 Logger.log(`Last message (ID: ${id}) deleted. Rolling back to previous state snapshot.`);
                 this.data.restoreStateFromSnapshot(this.previousStateSnapshot);
                 this.previousStateSnapshot = null;
                 await this.data.saveAllEntries();
                 this.ui.renderAll();
            }
        });

        eventSource.on(eventTypes.CHAT_CHANGED, () => {
            Logger.log('Chat changed. Resetting state snapshot and reloading data.');
            this.previousStateSnapshot = null;
            if (this.ui.isPanelVisible) {
                this.data.loadInitialState();
            }
        });
    }
}
