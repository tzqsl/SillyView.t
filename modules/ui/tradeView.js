/**
 * SillyView - Trade View
 * Renders the content for the 'Trade' tab in the sidebar.
 */
'use strict';

import { SillyViewConfig } from '../config.js';

export class TradeView {
    constructor(dependencies) {
        this.parentDoc = dependencies.parentDoc;
        this.data = dependencies.data;
        this.positionCalculator = dependencies.positionCalculator;
        this.ui = dependencies.ui; // Reference to the main UI renderer
    }

    render(container) {
        if (!container) return;
        
        const maxLeverage = SillyViewConfig.asset_definitions[this.ui.currentAsset]?.max_leverage || 1;
        const isLeverage = this.ui.tradeMode === 'leverage';
        const positionMode = isLeverage ? 'leveraged' : 'spot';
        const position = this.positionCalculator.calculate(this.ui.currentAsset, this.data.getState(SillyViewConfig.world_book_keys.player_portfolio), positionMode);
        const hasPosition = position.type !== null;
        const selectedLeverage = isLeverage && hasPosition
            ? Math.max(1, Math.round(position.leverage || 1))
            : Math.max(1, Number(this.ui.selectedLeverage || 1));

        // Determine button actions based on current position
        let buyAction, sellAction;
        if (!isLeverage) {
            buyAction = 'spot_buy';
            sellAction = 'spot_sell';
        } else if (position.type === 'long') {
            buyAction = 'add_long';
            sellAction = 'close_long';
        } else if (position.type === 'short') {
            buyAction = 'close_short';
            sellAction = 'add_short';
        } else {
            buyAction = 'open_long';
            sellAction = 'open_short';
        }
        
        // Dynamic button text
        const buyBtnText = {
            'spot_buy': hasPosition ? '买入 (加仓现货)' : '买入现货',
            'open_long': '买入 (做多)', 'add_long': '买入 (加仓)', 'close_short': '买入 (平空)'
        }[buyAction];
        
        const sellBtnText = {
            'spot_sell': '卖出现货',
            'open_short': '卖出 (做空)', 'add_short': '卖出 (加仓)', 'close_long': '卖出 (平多)'
        }[sellAction];

        const needsAmount = action => !action.startsWith('close') && action !== 'spot_sell';
        const showAmountInput = needsAmount(buyAction) || needsAmount(sellAction);
        
        const amountInputHtml = `
            <div>
                <label for="sillyview-trade-amount" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-gray-300);">${isLeverage ? '保证金' : '金额 (信用点)'}</label>
                <input type="number" id="sillyview-trade-amount" value="1000" class="sv-input" ${showAmountInput ? '' : 'disabled'}>
                <div style="display:grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap:0.5rem; margin-top:0.5rem;">
                    <button type="button" class="sv-button sv-trade-amount-preset" data-percent="0.1" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">10%</button>
                    <button type="button" class="sv-button sv-trade-amount-preset" data-percent="0.25" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">25%</button>
                    <button type="button" class="sv-button sv-trade-amount-preset" data-percent="0.5" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">50%</button>
                    <button type="button" class="sv-button sv-trade-amount-preset" data-percent="0.75" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">75%</button>
                    <button type="button" class="sv-button sv-trade-amount-preset" data-percent="1" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">全仓</button>
                </div>
                <div id="sillyview-risk-preview" style="font-size:0.75rem; margin-top:0.5rem; padding:0.5rem; border-radius:0.375rem; background-color:var(--bg-gray-900); color:var(--text-gray-400);"></div>
            </div>
        `;
        const riskControls = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio)
            ?.assets?.[this.ui.currentAsset]?.[positionMode]?.risk_controls || {};
        const riskInputHtml = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <div>
                    <label for="sillyview-take-profit" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-gray-300);">止盈价</label>
                    <input type="number" id="sillyview-take-profit" placeholder="可选" value="${riskControls.take_profit ?? ''}" class="sv-input" ${showAmountInput ? '' : 'disabled'}>
                </div>
                <div>
                    <label for="sillyview-stop-loss" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-gray-300);">止损价</label>
                    <input type="number" id="sillyview-stop-loss" placeholder="可选" value="${riskControls.stop_loss ?? ''}" class="sv-input" ${showAmountInput ? '' : 'disabled'}>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.5rem;">
                <button type="button" class="sv-button sv-risk-preset" data-risk-preset="long_safe" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">做多保护</button>
                <button type="button" class="sv-button sv-risk-preset" data-risk-preset="short_safe" ${showAmountInput ? '' : 'disabled'} style="background-color:var(--bg-gray-700); padding:0.45rem;">做空保护</button>
            </div>
        `;

        container.innerHTML = `
            <div>
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem;">数据窗口 - <span id="sillyview-asset-code-title">${this.ui.currentAsset}</span></h3>
                <div class="sv-data-grid">
                    <div><span>开:</span><span id="sillyview-data-open">-</span></div>
                    <div><span style="color:var(--green-400);">高:</span><span id="sillyview-data-high" style="color:var(--green-400);">-</span></div>
                    <div><span style="color:var(--red-400);">低:</span><span id="sillyview-data-low" style="color:var(--red-400);">-</span></div>
                    <div><span>收:</span><span id="sillyview-data-close">-</span></div>
                    <div class="col-span-2"><span>成交量:</span><span id="sillyview-data-volume">-</span></div>
                    <div class="col-span-2 sv-separator">
                        <div><span>未实现盈亏:</span><span id="sillyview-data-pnl">-</span></div>
                        <div style="font-size: 0.75rem; color: var(--text-gray-400);"><span>(金额 / 比例)</span><span id="sillyview-data-pnl-details"></span></div>
                    </div>
                </div>
            </div>
            <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                     <h3 style="font-size: 1.125rem; font-weight: 600;">交易面板</h3>
                     <div style="display: flex; align-items: center; gap: 0.5rem;">
                         <span style="font-size: 0.75rem; color: var(--text-gray-400);">现货 / 杠杆</span>
                         <label class="sv-toggle-switch">
                             <input type="checkbox" id="sillyview-leverage-mode-toggle" ${isLeverage ? 'checked' : ''}>
                             <span class="slider round"></span>
                         </label>
                     </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    <div id="sillyview-leverage-controls" style="display: ${isLeverage ? 'block' : 'none'};">
                        <label for="sillyview-leverage-slider" style="display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-gray-300);">加仓杠杆: <span id="leverage-value-display">${selectedLeverage}</span>x</label>
                        <input type="range" id="sillyview-leverage-slider" min="1" max="${maxLeverage}" value="${selectedLeverage}" style="width: 100%;">
                        <div id="leverage-info-box" style="font-size: 0.75rem; color:var(--text-gray-400); margin-top:0.5rem; padding:0.5rem; background-color:var(--bg-gray-900); border-radius:0.375rem; display:flex; flex-direction:column; gap:0.25rem;"></div>
                    </div>

                    ${amountInputHtml}
                    ${riskInputHtml}

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                        <button id="sillyview-buy-btn" class="sv-button sv-button-green" style="padding: 0.75rem 1rem;">${buyBtnText}</button>
                        <button id="sillyview-sell-btn" class="sv-button sv-button-red" style="padding: 0.75rem 1rem;">${sellBtnText}</button>
                    </div>
                </div>
            </div>
            <div>
                 <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem;">本回合操作</h3>
                 <div id="sillyview-this-turn-actions" style="font-size: 0.75rem; color: var(--text-gray-400); display:flex; flex-direction:column; gap:0.25rem; min-height: 50px;"></div>
            </div>
        `;
        if (isLeverage) this.updateLeverageInfo(selectedLeverage);
        this.updateRiskPreview();
        this.updateDataWindowWithLastCandle();
        this.renderThisTurnActions();
    }

    renderThisTurnActions() {
        const container = this.parentDoc.getElementById('sillyview-this-turn-actions');
        if (!container) return;
        const actions = this.data.getActionsThisTurn();
        if (actions.length === 0) {
            container.innerHTML = '<span>无</span>';
        } else {
            container.innerHTML = actions.map(a => `
                <div style="display:flex; justify-content: space-between;">
                    <span>${a.text}</span>
                    <span>${Number.isFinite(a.executedAt) ? `@ ${a.executedAt.toFixed(4)}` : ''}</span>
                </div>
            `).join('');
        }
    }
    
    updateDataWindowWithLastCandle() {
        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.ui.currentAsset}`);
        if (!assetData) return;
        const klineData = this.ui._getKlineDataForTimeframe(assetData);
        if (klineData && klineData.length > 0) {
            this.ui._updateDataWindow(klineData[klineData.length - 1]);
        }
    }

    updateActionButtonsState(isAnimating, isAITurn = false) {
        const buyBtn = this.parentDoc.getElementById('sillyview-buy-btn');
        const sellBtn = this.parentDoc.getElementById('sillyview-sell-btn');
        const endTurnBtn = this.parentDoc.getElementById('sillyview-end-turn-btn');
        const minuteBtns = [
            this.parentDoc.getElementById('sillyview-next-5m-btn'),
            this.parentDoc.getElementById('sillyview-next-15m-btn'),
            this.parentDoc.getElementById('sillyview-next-30m-btn'),
        ];
        const nextHourBtn = this.parentDoc.getElementById('sillyview-next-hour-btn');
        const advanceDayBtn = this.parentDoc.getElementById('sillyview-advance-day-btn');
        
        const timeButtonsDisabled = isAnimating || isAITurn;
        const tradeButtonsDisabled = isAnimating; // Only disable during animation
        
        if (buyBtn) buyBtn.disabled = tradeButtonsDisabled;
        if (sellBtn) sellBtn.disabled = tradeButtonsDisabled;

        if (endTurnBtn) {
            endTurnBtn.disabled = timeButtonsDisabled;
            if (isAITurn) endTurnBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 等待AI...';
            else endTurnBtn.textContent = '结束回合';
        }
        minuteBtns.forEach(btn => {
            if (btn) btn.disabled = timeButtonsDisabled;
        });
        if (nextHourBtn) nextHourBtn.disabled = timeButtonsDisabled;
        if (advanceDayBtn) advanceDayBtn.disabled = timeButtonsDisabled;
    }

    applyAmountPreset(percent) {
        const amountInput = this.parentDoc.getElementById('sillyview-trade-amount');
        if (!amountInput || amountInput.disabled) return;

        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const cash = Number(portfolio.cash || 0);
        const leverage = this.ui.tradeMode === 'leverage'
            ? parseInt(this.parentDoc.getElementById('sillyview-leverage-slider')?.value || 1, 10)
            : 1;
        const tradeConfig = SillyViewConfig.asset_definitions[this.ui.currentAsset]?.trade_config || {};
        const feeRate = Number(tradeConfig.fee_rate ?? 0.001);
        const maxMargin = cash / (1 + feeRate * leverage);
        const amount = Math.max(0, percent >= 1 ? maxMargin : cash * percent);
        amountInput.value = amount >= 100 ? amount.toFixed(0) : amount.toFixed(2);

        this.updateLeverageInfo(leverage);
        this.updateRiskPreview();
    }

    applyRiskPreset(preset) {
        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.ui.currentAsset}`);
        const currentPrice = Number(assetData?.current_price || 0);
        if (!currentPrice) return;

        const takeProfitInput = this.parentDoc.getElementById('sillyview-take-profit');
        const stopLossInput = this.parentDoc.getElementById('sillyview-stop-loss');
        if (!takeProfitInput || !stopLossInput || takeProfitInput.disabled || stopLossInput.disabled) return;

        const isShort = preset === 'short_safe';
        const signal = this.data.getKlineSignal(this.ui.currentAsset);
        const volatilityPct = Math.max(0.2, Math.min(2.5, Number(signal?.minute?.volatility_pct || 0.4)));
        const target = signal?.active_targets?.short || signal?.active_targets?.long;
        const targetPrice = Number(target?.target_price || 0);
        const stopDistance = Math.max(0.008, (volatilityPct / 100) * 1.8);
        const takeDistance = Math.max(0.014, (volatilityPct / 100) * 3.2);
        let takeProfit = isShort ? currentPrice * (1 - takeDistance) : currentPrice * (1 + takeDistance);
        const stopLoss = isShort ? currentPrice * (1 + stopDistance) : currentPrice * (1 - stopDistance);
        if (Number.isFinite(targetPrice) && targetPrice > 0) {
            if (!isShort && targetPrice > currentPrice) takeProfit = Math.min(takeProfit, targetPrice);
            if (isShort && targetPrice < currentPrice) takeProfit = Math.max(takeProfit, targetPrice);
        }
        takeProfitInput.value = takeProfit.toFixed(4);
        stopLossInput.value = stopLoss.toFixed(4);
        this.updateRiskPreview();
    }

    updateRiskPreview() {
        const preview = this.parentDoc.getElementById('sillyview-risk-preview');
        const amountInput = this.parentDoc.getElementById('sillyview-trade-amount');
        if (!preview || !amountInput) return;

        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const stats = this.data.calculatePerformanceStats(portfolio);
        const cash = Number(portfolio.cash || 0);
        const amount = Number(amountInput.value || 0);
        const leverage = this.ui.tradeMode === 'leverage'
            ? parseInt(this.parentDoc.getElementById('sillyview-leverage-slider')?.value || 1, 10)
            : 1;
        const cashUsagePct = cash > 0 ? (amount / cash) * 100 : 0;
        const exposurePct = stats.netWorth > 0 ? ((amount * leverage) / stats.netWorth) * 100 : 0;

        let label = '稳健';
        let color = 'var(--green-400)';
        if (cashUsagePct > 50 || exposurePct > 150) {
            label = '高风险';
            color = 'var(--red-400)';
        } else if (cashUsagePct > 25 || exposurePct > 75) {
            label = '进取';
            color = 'var(--yellow-400)';
        }

        preview.innerHTML = `
            <span>风险档位: <span style="color:${color}; font-weight:600;">${label}</span></span>
            <span style="display:block; margin-top:0.25rem;">占用现金 ${cashUsagePct.toFixed(1)}%，名义敞口 ${exposurePct.toFixed(1)}%</span>
        `;
    }

    updateLeverageInfo(leverage) {
        const display = this.parentDoc.getElementById('leverage-value-display');
        const infoBox = this.parentDoc.getElementById('leverage-info-box');
        const amountInput = this.parentDoc.getElementById('sillyview-trade-amount');
        this.updateRiskPreview();
        if (!display || !infoBox || !amountInput) return;

        const margin = parseFloat(amountInput.value) || 0;
        const positionValue = margin * leverage;

        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.ui.currentAsset}`);
        const currentPrice = assetData ? assetData.current_price : 0;
        const maintenanceMarginRate = SillyViewConfig.asset_definitions[this.ui.currentAsset]?.trade_config?.maintenance_margin_rate ?? 0.01;
        const shares = currentPrice > 0 ? positionValue / currentPrice : 0;
        
        const liquidationPriceLong = shares > 0
            ? Math.max((currentPrice * shares - margin) / (shares * (1 - maintenanceMarginRate)), 0)
            : 0;
        const liquidationPriceShort = shares > 0
            ? Math.max((margin + currentPrice * shares) / (shares * (1 + maintenanceMarginRate)), 0)
            : 0;

        display.textContent = leverage;
        infoBox.innerHTML = `
            <div>保证金: <span class="text-white font-mono">${margin.toFixed(2)}</span></div>
            <div>仓位价值: <span class="text-white font-mono">${positionValue.toFixed(2)}</span></div>
            <div>维持保证金率: <span class="text-white font-mono">${(maintenanceMarginRate * 100).toFixed(2)}%</span></div>
            <div>预估强平价 (多): <span class="text-yellow-400 font-mono">${liquidationPriceLong > 0 ? liquidationPriceLong.toFixed(4) : 'N/A'}</span></div>
            <div>预估强平价 (空): <span class="text-yellow-400 font-mono">${liquidationPriceShort > 0 ? liquidationPriceShort.toFixed(4) : 'N/A'}</span></div>
        `;
    }
}
