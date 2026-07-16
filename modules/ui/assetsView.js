/**
 * SillyView - Assets View
 * Renders the content for the 'Assets' tab in the sidebar.
 */
'use strict';

import { SillyViewConfig } from '../config.js';

export class AssetsView {
    constructor(dependencies) {
        this.parentDoc = dependencies.parentDoc;
        this.data = dependencies.data;
        this.positionCalculator = dependencies.positionCalculator;
    }

    render(container) {
        if (!container) return;

        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        if (!portfolio) {
            container.innerHTML = '<p>无法加载资产信息。</p>';
            return;
        }

        const financialStatusHtml = this.renderFinancialStatus(portfolio);
        const positionsHtml = this.renderPositions(portfolio);

        container.innerHTML = `
            ${financialStatusHtml}
            <div>
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 1rem;">我的仓位</h3>
                ${positionsHtml}
            </div>
        `;
    }

    renderFinancialStatus(portfolio) {
        const cash = portfolio.cash || 0;
        const debt = portfolio.debt || 0;

        const totalAssetValue = this.calculateTotalAssetValue(portfolio);
        const netWorth = cash + totalAssetValue - debt;
        const maxLoan = netWorth * SillyViewConfig.loan_config.credit_limit_multiplier - debt;

        return `
            <div>
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">财务状况</h3>
                <div class="sv-data-grid" style="grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem;">
                    <span>可用现金:</span><span style="font-family: monospace; color: white;">${cash.toFixed(2)}</span>
                    <span>总负债:</span><span style="font-family: monospace; color: var(--red-400);">${debt.toFixed(2)}</span>
                    <span>最大可贷款:</span><span style="font-family: monospace; color: white;">${Math.max(0, maxLoan).toFixed(2)}</span>
                </div>
                <div class="grid grid-cols-2 gap-4 mt-4" style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem; margin-top:1rem;">
                    <button id="sv-loan-btn" class="sv-button sv-button-blue" ${maxLoan <= 0 ? 'disabled' : ''}>申请贷款</button>
                    <button id="sv-repay-btn" class="sv-button" style="background-color: var(--bg-gray-600);" ${!debt || debt <= 0 ? 'disabled' : ''}>偿还贷款</button>
                </div>
            </div>
        `;
    }

    renderPositions(portfolio) {
        let assetsHtml = `<div class="sv-assets-list">`;
        let hasPositions = false;

        Object.keys(portfolio.assets || {}).forEach(assetCode => {
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (position.totalAmount > 0) {
                hasPositions = true;
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = assetData?.current_price ?? 0;
                
                const pnl = position.type === 'long' 
                    ? (lastPrice - position.avgEntryPrice) * position.totalShares
                    : (position.avgEntryPrice - lastPrice) * position.totalShares;
                
                const currentValue = position.totalAmount + pnl;
                const pnlPercent = position.totalAmount > 0 ? (pnl / position.totalAmount) * 100 : 0;
                const pnlColor = pnl >= 0 ? 'var(--green-400)' : 'var(--red-400)';
                const sign = pnl >= 0 ? '+' : '';

                const typeLabel = position.type === 'long' 
                    ? `<span style="color:var(--green-400); font-weight:bold;">多头</span>` 
                    : `<span style="color:var(--red-400); font-weight:bold;">空头</span>`;
                const riskControls = portfolio.assets?.[assetCode]?.risk_controls || {};
                const takeProfit = Number(riskControls.take_profit);
                const stopLoss = Number(riskControls.stop_loss);
                const takeProfitValue = Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit.toFixed(4) : '';
                const stopLossValue = Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss.toFixed(4) : '';
                const takeProfitText = takeProfitValue || '未设置';
                const stopLossText = stopLossValue || '未设置';

                assetsHtml += `
                    <div class="sv-asset-item" data-asset-code="${assetCode}">
                        <div class="sv-asset-item-header">
                            <span class="sv-asset-item-code">${assetCode} ${typeLabel} ${position.isLeveraged ? `(${position.leverage}x)` : ''}</span>
                            <span class="sv-asset-item-pnl" style="color:${pnlColor};">${sign}${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%)</span>
                        </div>
                        <div class="sv-asset-item-details">
                            <span>保证金:</span><span>${position.totalAmount.toFixed(2)}</span>
                            <span>当前价值:</span><span>${currentValue.toFixed(2)}</span>
                            <span>平均成本价:</span><span>${position.avgEntryPrice.toFixed(4)}</span>
                            <span>当前市价:</span><span>${lastPrice.toFixed(4)}</span>
                            <span>止盈价:</span><span>${takeProfitText}</span>
                            <span>止损价:</span><span>${stopLossText}</span>
                        </div>
                        <div class="sv-position-risk-controls">
                            <label>
                                <span>止盈</span>
                                <input type="number" step="any" min="0" placeholder="未设置" value="${takeProfitValue}" class="sv-input" data-risk-field="take_profit">
                            </label>
                            <label>
                                <span>止损</span>
                                <input type="number" step="any" min="0" placeholder="未设置" value="${stopLossValue}" class="sv-input" data-risk-field="stop_loss">
                            </label>
                            <button type="button" class="sv-button sv-button-blue sv-position-risk-save" data-asset-code="${assetCode}">保存调整</button>
                        </div>
                    </div>
                `;
            }
        });

        if (!hasPositions) assetsHtml += '<p style="color: var(--text-gray-500); font-style: italic;">当前没有持仓。</p>';
        assetsHtml += '</div>';
        return assetsHtml;
    }
    
    calculateTotalAssetValue(portfolio) {
        return Object.keys(portfolio.assets || {}).reduce((sum, assetCode) => {
            const position = this.positionCalculator.calculate(assetCode, portfolio);
            if (position.totalAmount > 0) {
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = assetData?.current_price ?? 0;
                 const pnl = position.type === 'long' 
                    ? (lastPrice - position.avgEntryPrice) * position.totalShares
                    : (position.avgEntryPrice - lastPrice) * position.totalShares;
                return sum + position.totalAmount + pnl;
            }
            return sum;
        }, 0);
    }
}
