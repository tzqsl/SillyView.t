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
        const questHtml = this.renderQuestBoard(portfolio);
        const performanceHtml = this.renderPerformanceStats(portfolio);
        const positionsHtml = this.renderPositions(portfolio);

        container.innerHTML = `
            ${financialStatusHtml}
            ${questHtml}
            ${performanceHtml}
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

    renderQuestBoard(portfolio) {
        const logs = portfolio.transaction_log || [];
        const hasOpenedTrade = logs.some(log => /开多|开空|加仓/.test(String(log.description || '')));
        const hasClosedTrade = logs.some(log => /平多|平空|止盈平仓|止损平仓/.test(String(log.description || '')));
        const hasRiskControls = Object.values(portfolio.assets || {}).some(asset => {
            const controls = asset?.risk_controls || {};
            return Number(controls.take_profit) > 0 || Number(controls.stop_loss) > 0;
        });
        const hasAdvancedMarket = (portfolio.asset_history || []).length >= 2;
        const stats = this.data.calculatePerformanceStats(portfolio);

        const quests = [
            { done: (portfolio.starting_cash || portfolio.cash || 0) > 0, title: '资金就绪', hint: '新账户自带 10000 信用点。' },
            { done: hasOpenedTrade, title: '完成首笔交易', hint: '在交易页用 10%/25%/50% 快捷金额开仓。' },
            { done: hasRiskControls, title: '设置保护', hint: '使用做多保护或做空保护自动填止盈止损。' },
            { done: hasAdvancedMarket, title: '推进一次市场', hint: '结束回合或打开快速模式看行情变化。' },
            { done: hasClosedTrade, title: '完成一笔平仓', hint: '主动平仓，或让止盈止损自动触发。' },
            { done: stats.returnPct > 0, title: '账户转正', hint: '让当前净值高于初始资金。' },
        ];

        const completed = quests.filter(quest => quest.done).length;
        const nextQuest = quests.find(quest => !quest.done);
        const progressPct = Math.round((completed / quests.length) * 100);
        const questItems = quests.map(quest => `
            <div style="display:flex; align-items:flex-start; gap:0.5rem; padding:0.35rem 0;">
                <span style="color:${quest.done ? 'var(--green-400)' : 'var(--text-gray-500)'}; font-weight:700;">${quest.done ? '✓' : '○'}</span>
                <span>
                    <span style="color:${quest.done ? 'white' : 'var(--text-gray-300)'}; font-weight:600;">${quest.title}</span>
                    <span style="display:block; color:var(--text-gray-500); font-size:0.75rem;">${quest.hint}</span>
                </span>
            </div>
        `).join('');

        return `
            <div style="margin-top: 1.5rem;">
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.75rem;">任务板</h3>
                <div style="background-color: var(--bg-gray-900); border: 1px solid var(--bg-gray-700); border-radius: 0.375rem; padding: 0.75rem;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:0.5rem;">
                        <span style="font-size:0.875rem; color:var(--text-gray-300);">进度 ${completed}/${quests.length}</span>
                        <span style="font-family:monospace; color:var(--cyan-400);">${progressPct}%</span>
                    </div>
                    <div style="height:0.5rem; background-color:var(--bg-gray-700); border-radius:999px; overflow:hidden; margin-bottom:0.75rem;">
                        <div style="height:100%; width:${progressPct}%; background-color:var(--cyan-400);"></div>
                    </div>
                    ${nextQuest ? `<div style="font-size:0.75rem; color:var(--text-gray-400); margin-bottom:0.5rem;">下一步：${nextQuest.title}</div>` : `<div style="font-size:0.75rem; color:var(--green-400); margin-bottom:0.5rem;">基础目标已全部完成。</div>`}
                    <div>${questItems}</div>
                </div>
            </div>
        `;
    }

    renderPerformanceStats(portfolio) {
        const stats = this.data.calculatePerformanceStats(portfolio);
        const returnColor = stats.returnPct >= 0 ? 'var(--green-400)' : 'var(--red-400)';
        const pnlColor = stats.realizedPnl >= 0 ? 'var(--green-400)' : 'var(--red-400)';
        const sign = value => value >= 0 ? '+' : '';

        return `
            <div style="margin-top: 1.5rem;">
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">绩效统计</h3>
                <div class="sv-data-grid" style="grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem;">
                    <span>初始资金:</span><span style="font-family: monospace; color: white;">${stats.startingCash.toFixed(2)}</span>
                    <span>当前净值:</span><span style="font-family: monospace; color: white;">${stats.netWorth.toFixed(2)}</span>
                    <span>总收益率:</span><span style="font-family: monospace; color: ${returnColor};">${sign(stats.returnPct)}${stats.returnPct.toFixed(2)}%</span>
                    <span>最大回撤:</span><span style="font-family: monospace; color: var(--red-400);">${stats.maxDrawdownPct.toFixed(2)}%</span>
                    <span>已实现盈亏:</span><span style="font-family: monospace; color: ${pnlColor};">${sign(stats.realizedPnl)}${stats.realizedPnl.toFixed(2)}</span>
                    <span>胜率:</span><span style="font-family: monospace; color: white;">${stats.tradeCount > 0 ? `${stats.winRatePct.toFixed(1)}% (${stats.winningTrades}/${stats.tradeCount})` : '-'}</span>
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
