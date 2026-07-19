/**
 * Runs the hidden role-decision pass before the normal frontend generation.
 */
'use strict';

export class RoleDecisionService {
    constructor(dependencies) {
        this.th = dependencies.th;
        this.data = dependencies.data;
        this.commandParser = dependencies.commandParser;
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.lastRun = null;
        this.lastCapture = null;
        this.running = false;
    }

    isEnabled() {
        return Boolean(this._getSettings().enabled);
    }

    isDebugEnabled() {
        return Boolean(this._getSettings().debug_enabled);
    }

    _getSettings() {
        const configState = this.data.getState(this.config.world_book_keys.config) || {};
        return {
            ...this.config.role_ai_defaults,
            ...(configState.role_ai || {}),
        };
    }

    extractContent(text) {
        const source = String(text || '').trim();
        if (!source) return '';
        const matches = [...source.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi)]
            .map(match => match[1].trim())
            .filter(Boolean);
        return matches.length > 0 ? matches.join('\n\n') : source;
    }

    _isUserMessage(message) {
        return message?.role === 'user' || message?.is_user === true;
    }

    _isAssistantMessage(message) {
        if (message?.role) return message.role === 'assistant';
        return message?.is_user === false && message?.is_system !== true;
    }

    captureTurnContext(userMessageId) {
        const messageId = Number(userMessageId);
        const messages = this.th.getChatMessages(`0-${messageId}`) || [];
        const current = [...messages].reverse().find(message =>
            Number(message.message_id) === messageId && this._isUserMessage(message)
        );
        if (!current) return null;

        const previousAssistant = [...messages].reverse().find(message =>
            Number(message.message_id) < messageId && this._isAssistantMessage(message) && !message.is_hidden
        );
        const context = {
            user_message_id: messageId,
            previous_message_id: previousAssistant ? Number(previousAssistant.message_id) : null,
            previous_content: this.extractContent(previousAssistant?.message || '').slice(0, 16000),
            user_content: this.extractContent(current.message || '').slice(0, 16000),
            captured_at: Date.now(),
        };
        this.lastCapture = context;
        return context;
    }

    async _loadPromptGuides() {
        return await this.data.getManagedRolePromptGuides();
    }

    async _loadRoleProfiles() {
        return await this.data.getManagedRoleProfiles();
    }

    async _generate(orderedPrompts, suffix) {
        if (!this.th?.generateRaw) throw new Error('TavernHelper.generateRaw 不可用。');
        const settings = this._getSettings();
        const customApi = this._buildCustomApi(settings);
        const generationId = `sillyview-role-${Date.now()}-${suffix}`;
        const generationPromise = this.th.generateRaw({
            generation_id: generationId,
            should_stream: false,
            should_silence: true,
            max_chat_history: 0,
            custom_api: customApi,
            ordered_prompts: orderedPrompts,
        });
        const timeoutMs = Math.max(1000, Number(settings.timeout_ms) || 60000);
        let timeoutHandle;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                this.th.stopGenerationById?.(generationId);
                reject(new Error(`角色决策请求超时（${timeoutMs}ms）。`));
            }, timeoutMs);
        });
        try {
            return await Promise.race([generationPromise, timeoutPromise]);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }
    }

    _buildCustomApi(settings) {
        if (!settings.custom_api_enabled) return undefined;
        const customApi = {};
        if (settings.apiurl?.trim()) customApi.apiurl = settings.apiurl.trim();
        if (settings.key?.trim()) customApi.key = settings.key.trim();
        if (settings.model?.trim()) customApi.model = settings.model.trim();
        if (settings.source?.trim()) customApi.source = settings.source.trim();
        if (Number.isFinite(settings.temperature)) customApi.temperature = settings.temperature;
        if (Number.isFinite(settings.max_tokens) && settings.max_tokens > 0) customApi.max_tokens = settings.max_tokens;
        return Object.keys(customApi).length > 0 ? customApi : undefined;
    }

    _buildRoleSystemPrompt(commandGuide, outputRules, roleProfiles) {
        const profileText = roleProfiles.length > 0
            ? roleProfiles.map(profile => profile.content).join('\n\n')
            : '未导入角色人设。';
        return [
            '你是 SillyView 的幕后角色决策 AI，不是与用户直接对话的前台 AI。',
            '本次只根据上一条角色正文和用户本轮信息，分别判断相关角色的内心活动、下一步剧情倾向，以及是否会主动查看手机、市场或自己的账户。',
            '不要续写面向用户的正文、对白或旁白，不要假定角色知道尚未观察的账户和行情。',
            '如果当前上下文不足以支持具体交易，先观察或保持不行动，禁止编造余额、持仓、价格和新闻。',
            '',
            '【本次可用的全部角色人设】',
            profileText,
            '',
            outputRules,
            '',
            commandGuide,
        ].join('\n');
    }

    _stripCommandBlocks(text) {
        return String(text || '')
            .replace(/<command>[\s\S]*?<\/command>/gi, '')
            .trim();
    }

    async _executeTradeCommands(text, observedAccountIds = new Set()) {
        const commands = this.commandParser.parse(text).filter(command => command.module === 'Trade');
        const results = [];
        for (const command of commands) {
            const accountId = command.args?.[0];
            if (typeof accountId !== 'string' || !observedAccountIds.has(accountId)) {
                results.push({
                    type: command.type,
                    args: command.args,
                    executed: false,
                    reason: '本轮未观察该账户，已拒绝执行。',
                });
                continue;
            }
            const ok = await this.data.processManagedAccountTradeCommand(command);
            results.push({ type: command.type, args: command.args, executed: Boolean(ok) });
        }
        return results;
    }

    _buildFrontendInjection(roleDecision, tradeResults) {
        const tradeSummary = tradeResults.length > 0
            ? tradeResults.map(item => `- ${item.type}: ${item.executed ? '已执行' : (item.reason || '执行失败')}`).join('\n')
            : '- 本轮没有角色交易动作。';
        return [
            '【SillyView 幕后角色决策，仅供本次前台生成使用】',
            '以下内容不是用户发言，不要逐字复述、展示标签或解释系统流程。请把角色心理和剧情倾向自然落实到接下来的正文，并保持与上一条正文及用户本轮信息连贯。',
            '',
            `幕后角色决策：\n${this._stripCommandBlocks(roleDecision) || '未提供额外决策。'}`,
            '',
            `角色交易执行结果：\n${tradeSummary}`,
        ].join('\n');
    }

    async run(context) {
        if (!context || this.running) return null;
        this.running = true;
        const startedAt = Date.now();
        let activeSessionId = null;
        try {
            const [promptGuides, roleProfiles] = await Promise.all([
                this._loadPromptGuides(),
                this._loadRoleProfiles(),
            ]);
            const systemPrompt = this._buildRoleSystemPrompt(
                promptGuides.command_guide,
                promptGuides.output_rules,
                roleProfiles
            );
            let output = await this._generate([
                { role: 'system', content: systemPrompt },
                { role: 'assistant', content: `【上一条角色正文】\n${context.previous_content || '无。'}` },
                { role: 'user', content: `【用户本轮信息】\n${context.user_content}` },
            ], 'initial');

            const observationRounds = [];
            const observedAccountIds = new Set();
            const maxObservationRounds = Math.max(4, Math.floor(Number(this._getSettings().max_observation_rounds) || 4));
            for (let round = 1; round <= maxObservationRounds; round++) {
                const commands = this.commandParser.parse(output);
                if (!commands.some(command => command.module === 'Observe')) break;
                const session = await this.data.beginManagedObservationSession(commands);
                if (!session.active) {
                    observationRounds.push({ round, active: false, rejected: session.rejected || [], unknown_account_ids: session.unknown_account_ids || [] });
                    break;
                }

                activeSessionId = session.id;
                let nextOutput;
                try {
                    nextOutput = await this._generate([
                        { role: 'system', content: systemPrompt },
                        { role: 'assistant', content: output },
                        {
                            role: 'user',
                            content: [
                                '【观察结果】',
                                session.context,
                                '',
                                '角色已经完成上述查看。请更新各角色的内心活动与剧情大纲；可以交易、继续观察或保持不行动。仍严格按照角色输出规范生成，并在末尾保留唯一的 <command> 块。',
                            ].join('\n'),
                        },
                    ], `observe-${round}`);
                    await this.data.endManagedObservationSession(session.id, { markObserved: true });
                    activeSessionId = null;
                } catch (error) {
                    await this.data.endManagedObservationSession(session.id, { markObserved: false });
                    activeSessionId = null;
                    throw error;
                }
                observationRounds.push({
                    round,
                    active: true,
                    account_ids: session.account_ids,
                    market_requested: session.market_requested,
                    activated_entries: session.activated_entries,
                });
                (session.account_ids || []).forEach(accountId => observedAccountIds.add(accountId));
                output = nextOutput;
            }

            const tradeResults = await this._executeTradeCommands(output, observedAccountIds);
            const injection = this._buildFrontendInjection(output, tradeResults);
            this.lastRun = {
                status: 'completed',
                started_at: startedAt,
                completed_at: Date.now(),
                context,
                role_profile_entries: roleProfiles.map(profile => profile.entry_name),
                observation_rounds: observationRounds,
                raw_output: output,
                trade_results: tradeResults,
                frontend_injection: injection,
            };
            return this.lastRun;
        } catch (error) {
            if (activeSessionId) {
                await this.data.endManagedObservationSession(activeSessionId, { markObserved: false });
            }
            this.lastRun = {
                status: 'failed',
                started_at: startedAt,
                completed_at: Date.now(),
                context,
                error: error?.message || String(error),
            };
            throw error;
        } finally {
            this.running = false;
        }
    }
}
