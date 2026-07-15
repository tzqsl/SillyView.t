/**
 * SillyView - Background AI Service
 * Runs market-director prompts through TavernHelper.generateRaw without touching chat input or chat messages.
 */
'use strict';

import { loadMarketDirectorRules } from './marketPromptRules.js';

export class BackgroundAIService {
    constructor(dependencies) {
        this.th = dependencies.th;
        this.logger = dependencies.logger;
        this.config = dependencies.config;
        this.data = dependencies.data;
    }

    _getSettings() {
        const configState = this.data.getState(this.config.world_book_keys.config) || {};
        return {
            ...this.config.background_ai_defaults,
            ...(configState.background_ai || {}),
        };
    }

    _buildCustomApi(settings) {
        if (!settings.enabled) return undefined;

        const customApi = {};
        if (settings.proxy_preset?.trim()) customApi.proxy_preset = settings.proxy_preset.trim();
        if (settings.apiurl?.trim()) customApi.apiurl = settings.apiurl.trim();
        if (settings.key?.trim()) customApi.key = settings.key.trim();
        if (settings.model?.trim()) customApi.model = settings.model.trim();
        if (settings.source?.trim()) customApi.source = settings.source.trim();

        if (Number.isFinite(settings.temperature)) customApi.temperature = settings.temperature;
        if (Number.isFinite(settings.max_tokens) && settings.max_tokens > 0) customApi.max_tokens = settings.max_tokens;

        return Object.keys(customApi).length > 0 ? customApi : undefined;
    }

    async generateMarketResponse(marketPrompt) {
        if (!this.th?.generateRaw) {
            throw new Error('TavernHelper.generateRaw 不可用，无法进行后台静默生成。');
        }

        const settings = this._getSettings();
        const customApi = this._buildCustomApi(settings);
        const generationId = `sillyview-market-${Date.now()}`;
        const marketDirectorRules = await loadMarketDirectorRules();

        this.logger.log(`SillyView background market generation started (${settings.enabled ? 'custom model' : 'current tavern model'}).`);

        return await this.th.generateRaw({
            generation_id: generationId,
            should_stream: false,
            should_silence: true,
            user_input: marketPrompt,
            custom_api: customApi,
            ordered_prompts: [
                {
                    role: 'system',
                    content: [
                        '你是 SillyView 的后台市场导演。',
                        '你只负责根据上下文生成市场新闻、时间推进和结构化指令。',
                        '不要扮演聊天角色，不要延续普通聊天，不要向用户寒暄。',
                        marketDirectorRules,
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: marketPrompt,
                },
            ],
        });
    }
}
