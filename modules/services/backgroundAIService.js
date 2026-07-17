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
        if (settings.apiurl?.trim()) customApi.apiurl = settings.apiurl.trim();
        if (settings.key?.trim()) customApi.key = settings.key.trim();
        if (settings.model?.trim()) customApi.model = settings.model.trim();
        if (settings.source?.trim()) customApi.source = settings.source.trim();

        if (Number.isFinite(settings.temperature)) customApi.temperature = settings.temperature;
        if (Number.isFinite(settings.max_tokens) && settings.max_tokens > 0) customApi.max_tokens = settings.max_tokens;

        return Object.keys(customApi).length > 0 ? customApi : undefined;
    }

    _assertMarketPromptIsolation(...contents) {
        const forbiddenEntries = [
            this.config.world_book_keys.dialogue_context,
            this.config.world_book_keys.player_portfolio,
        ];
        const payload = contents.map(content => String(content || '')).join('\n');
        const leakedEntry = forbiddenEntries.find(entryName =>
            payload.toLowerCase().includes(String(entryName).toLowerCase())
        );
        if (leakedEntry) {
            throw new Error(`后台市场请求已阻止：检测到禁止发送的世界书条目 ${leakedEntry}。`);
        }
    }

    async _withTimeout(promise, generationId, timeoutMs) {
        let timeoutHandle = null;
        const timeoutSeconds = Math.round(timeoutMs / 1000);

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                try {
                    this.th.stopGenerationById?.(generationId);
                } catch (error) {
                    this.logger.warn('Stopping timed out market generation failed:', error);
                }
                reject(new Error(`后台市场模型生成超时（已等待 ${timeoutSeconds} 秒）。`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }
    }

    async generateMarketResponse(marketPrompt) {
        if (!this.th?.generateRaw) {
            throw new Error('TavernHelper.generateRaw 不可用，无法进行后台静默生成。');
        }

        const settings = this._getSettings();
        const customApi = this._buildCustomApi(settings);
        const generationId = `sillyview-market-${Date.now()}`;
        const marketDirectorRules = await loadMarketDirectorRules();
        this._assertMarketPromptIsolation(marketDirectorRules, marketPrompt);
        const timeoutMs = Number.isFinite(settings.timeout_ms) && settings.timeout_ms > 0
            ? settings.timeout_ms
            : this.config.background_ai_defaults.timeout_ms;

        this.logger.log(`SillyView background market generation started (${settings.enabled ? 'custom model' : 'current tavern model'}).`);

        const generationPromise = this.th.generateRaw({
            generation_id: generationId,
            should_stream: false,
            should_silence: true,
            custom_api: customApi,
            ordered_prompts: [
                {
                    role: 'system',
                    content: [
                        '你是 SillyView 的后台市场导演。',
                        '你只负责根据上下文生成市场新闻、时间推进和结构化指令。',
                        '不要扮演聊天角色，不要延续普通聊天，不要向用户寒暄。',
                        '优先级：最后一条用户任务 > 本系统消息 > 参考资料与世界书。',
                        '如果参考资料或世界书与最后一条用户任务冲突，必须优先完成最后一条用户任务。',
                        '必须特别关注用户任务末尾的 <task> 块。',
                    ].join('\n'),
                },
                {
                    role: 'system',
                    content: [
                        '以下是 SillyView 市场导演参考资料。它用于补充世界观、规则和可用指令，但优先级低于最后一条用户任务。',
                        marketDirectorRules,
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: marketPrompt,
                },
            ],
        });

        return await this._withTimeout(generationPromise, generationId, timeoutMs);
    }
}
