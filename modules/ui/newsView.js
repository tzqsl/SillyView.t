/**
 * SillyView - News View
 * Renders the content for the 'News' tab in the sidebar.
 */
'use strict';

import { SillyViewConfig } from '../config.js';

export class NewsView {
    constructor(dependencies) {
        this.data = dependencies.data;
    }

    render(container) {
        if (!container) return;
        
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        const news = market?.news_feed || [];
        
        let newsHtml = '<div class="sv-feed-list">';
        if (news.length === 0) {
            newsHtml += '<p style="color: var(--text-gray-500); font-style: italic;">暂无市场新闻。</p>';
        } else {
            // The news_feed is already in reverse chronological order
            news.forEach(item => {
                newsHtml += `
                    <div class="sv-feed-item">
                        <p>${item.headline}</p>
                        <p class="sv-feed-item-meta">时间点: ${item.time_index}</p>
                    </div>
                `;
            });
        }
        newsHtml += '</div>';
        container.innerHTML = newsHtml;
    }
}
