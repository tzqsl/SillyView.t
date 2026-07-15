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

        let logHtml = '<div class="sv-feed-list">';
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
        logHtml += '</div>';
        container.innerHTML = logHtml;
    }
}
