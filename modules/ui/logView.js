/**
 * SillyView - Log View
 * Renders the content for the 'Log' tab in the sidebar.
 */
'use strict';

import { SillyViewConfig } from '../config.js';

export class LogView {
    constructor(dependencies) {
        this.data = dependencies.data;
    }

    render(container) {
        if (!container) return;
        
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        const logs = portfolio?.transaction_log || [];
        const orders = (portfolio?.order_history || []).slice(0, 20);

        let logHtml = '<div class="sv-feed-list"><h3 class="sv-log-section-title">资金流水</h3>';
        if (logs.length === 0) {
            logHtml += '<p style="color: var(--text-gray-500); font-style: italic;">暂无交易记录。</p>';
        } else {
            logs.forEach(log => {
                const amountClass = log.amount >= 0 ? 'positive' : 'negative';
                const sign = log.amount >= 0 ? '+' : '';
                logHtml += `
                    <div class="sv-log-item">
                        <span>${log.description}</span>
                        <span class="sv-log-amount ${amountClass}">${sign}${log.amount.toFixed(2)}</span>
                    </div>
                `;
            });
        }
        logHtml += '<h3 class="sv-log-section-title">订单历史</h3>';
        if (orders.length === 0) {
            logHtml += '<p style="color: var(--text-gray-500); font-style: italic;">暂无订单历史。</p>';
        } else {
            const statusLabels = { filled: '已成交', cancelled: '已撤销', rejected: '已拒绝' };
            orders.forEach(order => {
                const status = order.status || 'cancelled';
                logHtml += `
                    <div class="sv-order-history-item">
                        <div>
                            <strong>${order.asset_code} ${order.side === 'buy' ? '买入' : '卖出'} ${order.order_type === 'limit' ? '限价' : '条件'}</strong>
                            <span>${order.mode === 'spot' ? '现货' : `${Number(order.leverage || 1)}x`} · ${Number(order.amount || 0).toFixed(2)}${order.oco_group_id ? ' · OCO' : ''}</span>
                        </div>
                        <div>
                            <span class="sv-order-status sv-order-status-${status}">${statusLabels[status] || status}</span>
                            <span>@ ${Number(order.filled_price || order.trigger_price || 0).toFixed(4)}</span>
                        </div>
                    </div>
                `;
            });
        }
        logHtml += '</div>';
        container.innerHTML = logHtml;
    }
}
