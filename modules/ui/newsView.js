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
        const archive = this.data.getState(SillyViewConfig.world_book_keys.news_archive) || {};
        const news = Array.isArray(archive.items) ? archive.items : [];
        const escapeHtml = value => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        
        let newsHtml = '<div class="sv-feed-list">';
        if (news.length === 0) {
            newsHtml += '<p style="color: var(--text-gray-500); font-style: italic;">暂无市场新闻。</p>';
        } else {
            news.forEach(item => {
                newsHtml += `
                    <div class="sv-feed-item">
                        <p>${escapeHtml(item.headline)}</p>
                        <p class="sv-feed-item-meta">${escapeHtml(item.asset_code || 'GLOBAL')} · 时间点 ${Number(item.created_at || 0)}</p>
                    </div>
                `;
            });
        }
        newsHtml += '</div>';
        container.innerHTML = newsHtml;
    }
}
