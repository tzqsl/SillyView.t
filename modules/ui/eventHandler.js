

/**
 * SillyView - Event Handler (v6.0 - Modular UI)
 * Binds events to dynamically created UI elements and handles global events.
 */
'use strict';

export class EventHandler {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.logger = dependencies.logger;
        this.parentDoc = dependencies.parentDoc;
        this.app = dependencies.app;
        this.ui = dependencies.ui;
        this.data = dependencies.data;
        this.modals = dependencies.modals;
        this.positionCalculator = dependencies.positionCalculator || dependencies.data?.positionCalculator;
        this.roleDecision = dependencies.roleDecision;
        this.resizeTimeout = null;
    }

    async saveBackgroundAISettings() {
        const settings = this.ui.collectBackgroundAISettings();
        await this.data.updateState(this.dependencies.config.world_book_keys.config, config => {
            config.background_ai = settings;
            return config;
        });
        return settings;
    }

    async saveRoleAISettings() {
        const settings = this.ui.collectRoleAISettings();
        await this.data.updateState(this.dependencies.config.world_book_keys.config, config => {
            config.role_ai = {
                ...this.dependencies.config.role_ai_defaults,
                ...(config.role_ai || {}),
                ...settings,
            };
            return config;
        });
        return settings;
    }

    async setRoleAIEnabled(enabled) {
        await this.data.updateState(this.dependencies.config.world_book_keys.config, config => {
            config.role_ai = {
                ...this.dependencies.config.role_ai_defaults,
                ...(config.role_ai || {}),
                enabled: Boolean(enabled),
            };
            return config;
        });
    }

    async setRoleDebugEnabled(enabled) {
        await this.data.updateState(this.dependencies.config.world_book_keys.config, config => {
            config.role_ai = {
                ...this.dependencies.config.role_ai_defaults,
                ...(config.role_ai || {}),
                debug_enabled: Boolean(enabled),
            };
            return config;
        });
    }

    refreshRoleDebugWindow() {
        const captureEl = this.parentDoc.getElementById('sv-role-capture-debug');
        const pipelineEl = this.parentDoc.getElementById('sv-role-pipeline-debug');
        if (captureEl) {
            captureEl.textContent = this.roleDecision?.lastCapture
                ? JSON.stringify(this.roleDecision.lastCapture, null, 2)
                : '尚未截取用户消息。';
        }
        if (pipelineEl) {
            pipelineEl.textContent = this.roleDecision?.lastRun
                ? JSON.stringify(this.roleDecision.lastRun, null, 2)
                : '尚未运行。';
        }
    }

    async openObservationDebugWindow() {
        const existing = this.parentDoc.querySelector('.sv-observation-debug-overlay');
        if (existing) existing.remove();
        const states = await this.data.getManagedAccountStates();
        const exampleId = states[0]?.account_id || 'acct_example';
        const modal = this.parentDoc.createElement('div');
        modal.className = 'sv-modal-overlay sv-observation-debug-overlay';
        modal.innerHTML = `
            <div class="sv-modal-content sv-observation-debug-modal">
                <div class="sv-debug-header">
                    <div>
                        <h3>角色观察调试</h3>
                        <p>模拟角色 AI 的首轮输出；激活后，下方内容就是二次请求应临时注入的数据。</p>
                    </div>
                    <button type="button" class="sv-icon-button" id="sv-observation-debug-close" title="关闭" aria-label="关闭">&times;</button>
                </div>
                <label class="sv-debug-label" for="sv-observation-debug-input">首轮角色 AI 输出</label>
                <textarea id="sv-observation-debug-input" class="sv-debug-textarea"><command>\n[Observe.Account("${exampleId}")]\n</command></textarea>
                <div class="sv-debug-actions">
                    <button type="button" id="sv-observation-debug-run" class="sv-button sv-button-blue">解析并激活</button>
                    <button type="button" id="sv-observation-debug-finish" class="sv-button sv-button-green">完成二轮并清理</button>
                    <button type="button" id="sv-observation-debug-refresh" class="sv-button">刷新状态</button>
                </div>
                <div class="sv-debug-grid">
                    <section>
                        <h4>世界书状态</h4>
                        <pre id="sv-observation-debug-state"></pre>
                    </section>
                    <section>
                        <h4>二轮临时上下文</h4>
                        <pre id="sv-observation-debug-context">尚未激活观察数据。</pre>
                    </section>
                    <section class="sv-debug-full-width">
                        <h4>自动截取的前文与用户输入</h4>
                        <pre id="sv-role-capture-debug">尚未截取用户消息。</pre>
                    </section>
                    <section class="sv-debug-full-width">
                        <h4>最近一次角色决策管线</h4>
                        <pre id="sv-role-pipeline-debug">尚未运行。</pre>
                    </section>
                </div>
            </div>`;
        this.parentDoc.body.appendChild(modal);

        const stateEl = modal.querySelector('#sv-observation-debug-state');
        const contextEl = modal.querySelector('#sv-observation-debug-context');
        const refresh = async () => {
            const state = await this.data.getManagedObservationDebugState();
            stateEl.textContent = JSON.stringify(state, null, 2);
            if (state.session?.context) contextEl.textContent = state.session.context;
            this.refreshRoleDebugWindow();
        };
        const cleanupAndClose = async () => {
            await this.app.finishRoleObservation(null, { markObserved: false });
            modal.remove();
        };

        modal.querySelector('#sv-observation-debug-run').addEventListener('click', async () => {
            const text = modal.querySelector('#sv-observation-debug-input').value;
            const result = await this.app.prepareRoleObservation(text);
            contextEl.textContent = result.second_request_context || JSON.stringify(result, null, 2);
            await refresh();
        });
        modal.querySelector('#sv-observation-debug-finish').addEventListener('click', async () => {
            const sessionId = this.data.activeManagedObservationSession?.id || null;
            await this.app.finishRoleObservation(sessionId, { markObserved: true });
            contextEl.textContent = '观察会话已完成；临时条目已关闭，本次看到的重大事件已标记为 observed。';
            await refresh();
        });
        modal.querySelector('#sv-observation-debug-refresh').addEventListener('click', refresh);
        modal.querySelector('#sv-observation-debug-close').addEventListener('click', cleanupAndClose);
        modal.addEventListener('click', event => {
            if (event.target === modal) cleanupAndClose();
        });
        await refresh();
    }

    _renderBackgroundModelList(models) {
        const listEl = this.parentDoc.getElementById('sv-bg-ai-model-list');
        if (!listEl) return;

        listEl.innerHTML = '';
        if (!models || models.length === 0) {
            const empty = this.parentDoc.createElement('div');
            empty.style.cssText = 'font-size:0.75rem; color:var(--text-gray-400);';
            empty.textContent = '未返回模型列表。';
            listEl.appendChild(empty);
            return;
        }

        models.forEach(model => {
            const button = this.parentDoc.createElement('button');
            button.type = 'button';
            button.className = 'sv-button sv-bg-ai-model-option';
            button.dataset.model = model;
            button.style.cssText = 'width:100%; text-align:left; justify-content:flex-start; background-color:var(--bg-gray-700);';
            button.textContent = model;
            listEl.appendChild(button);
        });
    }

    _renderRoleModelList(models) {
        const listEl = this.parentDoc.getElementById('sv-role-ai-model-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!models || models.length === 0) {
            const empty = this.parentDoc.createElement('div');
            empty.style.cssText = 'font-size:0.75rem; color:var(--text-gray-400);';
            empty.textContent = '未返回模型列表。';
            listEl.appendChild(empty);
            return;
        }
        models.forEach(model => {
            const button = this.parentDoc.createElement('button');
            button.type = 'button';
            button.className = 'sv-button sv-role-ai-model-option';
            button.dataset.model = model;
            button.style.cssText = 'width:100%; text-align:left; justify-content:flex-start; background-color:var(--bg-gray-700);';
            button.textContent = model;
            listEl.appendChild(button);
        });
    }

    _normalizeModelEndpoint(apiurl, source) {
        const trimmed = apiurl.trim().replace(/\/+$/, '');

        if (/\/models(?:\?.*)?$/i.test(trimmed)) return trimmed;

        if (source === 'google') {
            if (/generativelanguage\.googleapis\.com/i.test(trimmed)) {
                return `${trimmed.replace(/\/v1beta$/i, '').replace(/\/v1$/i, '')}/v1beta/models`;
            }
            return `${trimmed}/v1beta/models`;
        }

        const withoutCompletionPath = trimmed
            .replace(/\/chat\/completions$/i, '')
            .replace(/\/messages$/i, '')
            .replace(/\/completions$/i, '');

        if (/\/v\d+(?:beta)?$/i.test(withoutCompletionPath)) {
            return `${withoutCompletionPath}/models`;
        }

        return `${withoutCompletionPath}/v1/models`;
    }

    _buildModelHeaders(settings) {
        const headers = { Accept: 'application/json' };
        const key = settings.key?.trim();
        const source = settings.source?.trim();

        if (!key) return headers;

        if (source === 'claude') {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
        } else if (source !== 'google') {
            headers.Authorization = `Bearer ${key}`;
        }

        return headers;
    }

    _parseModelListResponse(payload, source) {
        const candidates = [];

        if (Array.isArray(payload?.data)) {
            candidates.push(...payload.data.map(item => item?.id || item?.name || item));
        }
        if (Array.isArray(payload?.models)) {
            candidates.push(...payload.models.map(item => item?.name || item?.id || item));
        }
        if (Array.isArray(payload)) {
            candidates.push(...payload.map(item => item?.id || item?.name || item));
        }

        return [...new Set(candidates
            .filter(model => typeof model === 'string' && model.trim())
            .map(model => source === 'google' ? model.replace(/^models\//, '') : model)
        )].sort((a, b) => a.localeCompare(b));
    }

    _buildCustomApi(settings, overrides = {}) {
        const customApi = {};
        if (settings.apiurl?.trim()) customApi.apiurl = settings.apiurl.trim();
        if (settings.key?.trim()) customApi.key = settings.key.trim();
        if (settings.model?.trim()) customApi.model = settings.model.trim();
        if (settings.source?.trim()) customApi.source = settings.source.trim();

        return {
            ...customApi,
            ...overrides,
        };
    }

    async _withTimeout(promise, timeoutMs, message) {
        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }
    }

    async _probeBackgroundModel(settings) {
        if (!settings.model?.trim()) {
            throw new Error('模型列表接口不可用。请手动填写模型名后再次点击，用实际生成请求测试连接。');
        }
        if (!this.dependencies.th?.generateRaw) {
            throw new Error('TavernHelper.generateRaw 不可用，无法测试后台模型连接。');
        }

        const generationId = `sillyview-model-probe-${Date.now()}`;
        const request = this.dependencies.th.generateRaw({
            generation_id: generationId,
            should_stream: false,
            should_silence: true,
            custom_api: this._buildCustomApi(settings, {
                max_tokens: 8,
                temperature: 0,
            }),
            ordered_prompts: [
                { role: 'system', content: 'Reply with OK only.' },
                { role: 'user', content: 'OK' },
            ],
        });

        try {
            await this._withTimeout(request, 30000, '后台模型连接测试超时。');
        } catch (error) {
            try {
                this.dependencies.th.stopGenerationById?.(generationId);
            } catch (stopError) {
                this.logger.warn('停止后台模型连接测试失败:', stopError);
            }
            throw error;
        }

        return [settings.model.trim()];
    }

    async _fetchModelsDirectly(settings) {
        const source = settings.source?.trim() || 'openai';
        let endpoint = this._normalizeModelEndpoint(settings.apiurl, source);

        if (source === 'google' && settings.key?.trim() && !/[?&]key=/.test(endpoint)) {
            endpoint += `${endpoint.includes('?') ? '&' : '?'}key=${encodeURIComponent(settings.key.trim())}`;
        }

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: this._buildModelHeaders(settings),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`${response.status} ${response.statusText}${body ? `: ${body.slice(0, 180)}` : ''}`);
        }

        const payload = await response.json();
        return this._parseModelListResponse(payload, source);
    }

    async fetchBackgroundModels() {
        const settings = this.ui.collectBackgroundAISettings();
        const fetchBtn = this.parentDoc.getElementById('sv-fetch-bg-ai-models-btn');

        if (!settings.apiurl) {
            this.dependencies.win.toastr.warning('请先填写 API 地址。');
            return;
        }

        try {
            if (fetchBtn) {
                fetchBtn.disabled = true;
                fetchBtn.textContent = '获取中...';
            }
            let models = [];
            try {
                models = await this.dependencies.th.getModelList({
                    apiurl: settings.apiurl,
                    key: settings.key || undefined,
                });
            } catch (helperError) {
                this.logger.warn('TavernHelper.getModelList 失败，尝试第三方 API 兼容模式:', helperError);
            }

            if (!models || models.length === 0) {
                try {
                    models = await this._fetchModelsDirectly(settings);
                } catch (directError) {
                    this.logger.warn('第三方模型列表直连失败，尝试使用当前模型做后台连通测试:', directError);
                    models = await this._probeBackgroundModel(settings);
                    this.dependencies.win.toastr.info('模型列表接口不可用，但当前填写的模型连接测试通过。');
                }
            }
            this._renderBackgroundModelList(models);
            this.dependencies.win.toastr.success(`已获取 ${models.length} 个模型。`);
        } catch (error) {
            this.logger.error('获取后台模型列表失败:', error);
            this.dependencies.win.toastr.error(`获取模型失败: ${error.message || error}`);
        } finally {
            if (fetchBtn) {
                fetchBtn.disabled = false;
                fetchBtn.textContent = '获取模型';
            }
        }
    }

    async fetchRoleModels() {
        const settings = this.ui.collectRoleAISettings();
        const fetchBtn = this.parentDoc.getElementById('sv-fetch-role-ai-models-btn');
        if (!settings.apiurl) {
            this.dependencies.win.toastr.warning('请先填写角色模型 API 地址。');
            return;
        }
        try {
            if (fetchBtn) {
                fetchBtn.disabled = true;
                fetchBtn.textContent = '获取中...';
            }
            let models = [];
            try {
                models = await this.dependencies.th.getModelList({ apiurl: settings.apiurl, key: settings.key || undefined });
            } catch (helperError) {
                this.logger.warn('TavernHelper.getModelList 获取角色模型失败，尝试兼容 API:', helperError);
            }
            if (!models || models.length === 0) {
                try {
                    models = await this._fetchModelsDirectly(settings);
                } catch (directError) {
                    this.logger.warn('角色模型列表直连失败，尝试当前模型连通测试:', directError);
                    models = await this._probeBackgroundModel(settings);
                    this.dependencies.win.toastr.info('模型列表接口不可用，但当前填写的角色模型连接测试通过。');
                }
            }
            this._renderRoleModelList(models);
            this.dependencies.win.toastr.success(`已获取 ${models.length} 个角色模型。`);
        } catch (error) {
            this.logger.error('获取角色模型列表失败:', error);
            this.dependencies.win.toastr.error(`获取角色模型失败: ${error.message || error}`);
        } finally {
            if (fetchBtn) {
                fetchBtn.disabled = false;
                fetchBtn.textContent = '获取模型';
            }
        }
    }

    bindInitialEvents() {
        this.bindEntryButton();
        this.bindResizeHandler();
    }

    bindEntryButton() {
        const entryButton = this.parentDoc.createElement('div');
        entryButton.id = 'sillyview-entry-button';
        entryButton.innerHTML = '<i class="fas fa-chart-line"></i>';
        this.parentDoc.body.appendChild(entryButton);
        
        entryButton.addEventListener('click', () => {
            this.logger.log("悬浮窗按钮被点击。");
            const sillyviewPanel = this.parentDoc.getElementById('sillyview-panel');
            
            if (!sillyviewPanel) {
                this.logger.error("SillyView panel element not found in the DOM!");
                return;
            }

            sillyviewPanel.classList.toggle('visible');
            this.ui.isPanelVisible = sillyviewPanel.classList.contains('visible');
            
            if (this.ui.isPanelVisible) {
                this.logger.log("面板变为可见，正在加载/刷新状态...");
                this.data.loadInitialState(); // Always load state when panel becomes visible
            }
        });

        this.logger.log("悬浮入口按钮已创建并绑定核心事件。");
    }

    bindResizeHandler() {
        this.dependencies.win.addEventListener('resize', () => {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                if (this.ui.isPanelVisible && this.ui.chartManager.isInitialized()) {
                    this.logger.log("窗口大小改变，正在调整UI...");
                    this.ui.handleResize();
                }
            }, 150);
        });
        this.logger.log("窗口缩放事件监听器已绑定。");
    }

    bindCreationEvents() {
        const yesButton = this.parentDoc.getElementById('sv-create-book-yes');
        const noButton = this.parentDoc.getElementById('sv-create-book-no');

        if (yesButton) {
            yesButton.addEventListener('click', () => {
                const autoAdvanceEnabled = Boolean(this.parentDoc.getElementById('sv-auto-advance-on-create')?.checked);
                this.logger.log("用户同意创建世界书...");
                yesButton.disabled = true;
                yesButton.textContent = "正在创建...";
                this.ui.renderInitializationProgress({
                    step: '创建',
                    title: '正在创建 SillyView 世界书',
                    detail: '正在准备初始化流程。',
                    percent: 3,
                });
                this.data.createInitialWorldState({ autoAdvance: { enabled: autoAdvanceEnabled } });
            });
        }
        if (noButton) {
            noButton.addEventListener('click', () => {
                const sillyviewPanel = this.parentDoc.getElementById('sillyview-panel');
                if (sillyviewPanel) {
                    sillyviewPanel.classList.remove('visible');
                    this.ui.isPanelVisible = false;
                }
            });
        }
    }

    _readPositionRiskValue(input, label) {
        const raw = input?.value?.trim();
        if (!raw) return null;

        const value = parseFloat(raw);
        if (!Number.isFinite(value) || value <= 0) {
            this.dependencies.win.toastr.error(`请输入有效的${label}。`);
            return undefined;
        }
        return value;
    }

    async adjustPositionRiskControls(assetCode, itemEl) {
        const mode = itemEl?.dataset.positionMode === 'spot' ? 'spot' : 'leveraged';
        const portfolio = this.data.getState(this.dependencies.config.world_book_keys.player_portfolio);
        const position = this.positionCalculator.calculate(assetCode, portfolio, mode);
        if (!position.type || position.totalAmount <= 0) {
            this.dependencies.win.toastr.warning('当前仓位不存在，无法调整止盈止损。');
            this.ui.renderAll();
            return;
        }

        const assetData = this.data.getState(`${this.dependencies.config.world_book_keys.asset_prefix}${assetCode}`);
        const currentPrice = assetData?.current_price ?? position.avgEntryPrice;
        const takeProfit = this._readPositionRiskValue(itemEl.querySelector('[data-risk-field="take_profit"]'), '止盈价');
        if (takeProfit === undefined) return;
        const stopLoss = this._readPositionRiskValue(itemEl.querySelector('[data-risk-field="stop_loss"]'), '止损价');
        if (stopLoss === undefined) return;

        const isLong = position.type === 'long';
        if (takeProfit !== null) {
            const invalid = isLong ? takeProfit <= currentPrice : takeProfit >= currentPrice;
            if (invalid) {
                this.dependencies.win.toastr.error(isLong ? '多头止盈价必须高于当前价。' : '空头止盈价必须低于当前价。');
                return;
            }
        }
        if (stopLoss !== null) {
            const invalid = isLong ? stopLoss >= currentPrice : stopLoss <= currentPrice;
            if (invalid) {
                this.dependencies.win.toastr.error(isLong ? '多头止损价必须低于当前价。' : '空头止损价必须高于当前价。');
                return;
            }
        }

        const updated = await this.data.updatePositionRiskControls(assetCode, {
            take_profit: takeProfit,
            stop_loss: stopLoss,
        }, mode);
        if (!updated) {
            this.dependencies.win.toastr.warning('当前仓位不存在，无法调整止盈止损。');
            this.ui.renderAll();
            return;
        }

        await this.data.updateAIContext();
        await this.data.saveAllEntries();
        this.dependencies.win.toastr.success(`${assetCode} 止盈止损已更新。`);
        this.ui.renderAll();
    }

    bindMainInterfaceEvents() {
        this.logger.log("正在绑定主界面事件...");
        
        const endTurnBtn = this.parentDoc.getElementById('sillyview-end-turn-btn');
        const quickModeToggle = this.parentDoc.getElementById('sillyview-quick-mode-toggle');
        const minuteBtn = this.parentDoc.getElementById('sv-timescale-minute');
        const hourlyBtn = this.parentDoc.getElementById('sv-timescale-hourly');
        const dailyBtn = this.parentDoc.getElementById('sv-timescale-daily');
        const candlestickChartBtn = this.parentDoc.getElementById('sv-chart-candlestick');
        const lineChartBtn = this.parentDoc.getElementById('sv-chart-line');
        const assetSelector = this.parentDoc.getElementById('sillyview-asset-selector');
        const syncBtn = this.parentDoc.getElementById('sillyview-sync-ai-btn');
        const next5mBtn = this.parentDoc.getElementById('sillyview-next-5m-btn');
        const next15mBtn = this.parentDoc.getElementById('sillyview-next-15m-btn');
        const next30mBtn = this.parentDoc.getElementById('sillyview-next-30m-btn');
        const nextHourBtn = this.parentDoc.getElementById('sillyview-next-hour-btn');
        const advanceDayBtn = this.parentDoc.getElementById('sillyview-advance-day-btn'); // New button
        const sidebar = this.parentDoc.querySelector('.sv-right-sidebar');
        
        // Time & Asset Controls
        if (endTurnBtn) endTurnBtn.addEventListener('click', async () => await this.app.commitAndAdvance());
        if (syncBtn) syncBtn.addEventListener('click', async () => await this.app.syncQuickModeWithAI());
        if (next5mBtn) next5mBtn.addEventListener('click', () => this.app.advanceQuickModeMinutes(5));
        if (next15mBtn) next15mBtn.addEventListener('click', () => this.app.advanceQuickModeMinutes(15));
        if (next30mBtn) next30mBtn.addEventListener('click', () => this.app.advanceQuickModeMinutes(30));
        if (nextHourBtn) nextHourBtn.addEventListener('click', () => this.app.advanceQuickModeHour());
        if (advanceDayBtn) advanceDayBtn.addEventListener('click', () => this.app.commitAndAdvance()); // Correctly calls commitAndAdvance
        if (quickModeToggle) quickModeToggle.addEventListener('change', (event) => this.app.onQuickModeToggled(event.target.checked));
        if (minuteBtn) minuteBtn.addEventListener('click', () => this.ui.setTimeframe('MINUTE'));
        if (hourlyBtn) hourlyBtn.addEventListener('click', () => this.ui.setTimeframe('HOURLY'));
        if (dailyBtn) dailyBtn.addEventListener('click', () => this.ui.setTimeframe('DAILY'));
        if (candlestickChartBtn) candlestickChartBtn.addEventListener('click', () => this.ui.setChartType('candlestick'));
        if (lineChartBtn) lineChartBtn.addEventListener('click', () => this.ui.setChartType('line'));
        if (assetSelector) assetSelector.addEventListener('change', (event) => this.ui.switchAsset(event.target.value));

        // Sidebar Delegated Events
        if (sidebar) {
            sidebar.addEventListener('click', async (event) => {
                const target = event.target;
                const tabButton = target.closest('.sv-sidebar-tab');
                const loanBtn = target.closest('#sv-loan-btn');
                const repayBtn = target.closest('#sv-repay-btn');
                const buyBtn = target.closest('#sillyview-buy-btn');
                const sellBtn = target.closest('#sillyview-sell-btn');
                const resetBtn = target.closest('#sv-reset-data-btn');
                const observationDebugBtn = target.closest('#sv-open-observation-debug-btn');
                const saveBgAiBtn = target.closest('#sv-save-bg-ai-btn');
                const fetchBgAiModelsBtn = target.closest('#sv-fetch-bg-ai-models-btn');
                const bgAiModelOption = target.closest('.sv-bg-ai-model-option');
                const saveRoleAiBtn = target.closest('#sv-save-role-ai-btn');
                const fetchRoleAiModelsBtn = target.closest('#sv-fetch-role-ai-models-btn');
                const roleAiModelOption = target.closest('.sv-role-ai-model-option');
                const positionRiskSaveBtn = target.closest('.sv-position-risk-save');
                const amountPresetBtn = target.closest('.sv-trade-amount-preset');
                const riskPresetBtn = target.closest('.sv-risk-preset');

                if (tabButton) {
                    this.ui.switchSidebarTab(tabButton.dataset.tab);
                } else if (observationDebugBtn) {
                    await this.openObservationDebugWindow();
                } else if (loanBtn) {
                    this.modals.showLoanModal('loan');
                } else if (repayBtn) {
                    this.modals.showLoanModal('repay');
                } else if (buyBtn) {
                    this.ui.initiateTrade('buy');
                } else if (sellBtn) {
                    this.ui.initiateTrade('sell');
                } else if (amountPresetBtn) {
                    this.ui.tradeView.applyAmountPreset(parseFloat(amountPresetBtn.dataset.percent || '0'));
                } else if (riskPresetBtn) {
                    this.ui.tradeView.applyRiskPreset(riskPresetBtn.dataset.riskPreset);
                } else if (saveBgAiBtn) {
                    await this.saveBackgroundAISettings();
                    this.dependencies.win.toastr.success("后台模型设置已保存。");
                    this.ui.renderAll();
                } else if (fetchBgAiModelsBtn) {
                    await this.fetchBackgroundModels();
                } else if (bgAiModelOption) {
                    const modelInput = this.parentDoc.getElementById('sv-bg-ai-model');
                    if (modelInput) modelInput.value = bgAiModelOption.dataset.model || '';
                    await this.saveBackgroundAISettings();
                    this.dependencies.win.toastr.success(`已选择模型: ${bgAiModelOption.dataset.model}`);
                    this.ui.renderAll();
                } else if (saveRoleAiBtn) {
                    await this.saveRoleAISettings();
                    this.dependencies.win.toastr.success('角色模型设置已保存。');
                    this.ui.renderAll();
                } else if (fetchRoleAiModelsBtn) {
                    await this.fetchRoleModels();
                } else if (roleAiModelOption) {
                    const modelInput = this.parentDoc.getElementById('sv-role-ai-model');
                    if (modelInput) modelInput.value = roleAiModelOption.dataset.model || '';
                    await this.saveRoleAISettings();
                    this.dependencies.win.toastr.success(`已选择角色模型: ${roleAiModelOption.dataset.model}`);
                    this.ui.renderAll();
                } else if (positionRiskSaveBtn) {
                    const itemEl = positionRiskSaveBtn.closest('.sv-asset-item');
                    const assetCode = positionRiskSaveBtn.dataset.assetCode || itemEl?.dataset.assetCode;
                    if (assetCode && itemEl) await this.adjustPositionRiskControls(assetCode, itemEl);
                } else if (resetBtn) {
                    this.modals.showConfirmation(
                        `<h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--red-400);">确认重置？</h3><p>此操作将永久删除当前角色的所有SillyView市场、资产和账户数据并重新开始，但会保留后台市场与角色模型设置。此操作无法撤销。</p>`,
                        () => this.data.resetAllData()
                    );
                }
            });

            sidebar.addEventListener('change', (event) => {
                const leverageToggle = event.target.closest('#sillyview-leverage-mode-toggle');
                const autoAdvanceToggle = event.target.closest('#sv-auto-advance-enabled');
                const roleAIToggle = event.target.closest('#sv-role-ai-enabled');
                const roleDebugToggle = event.target.closest('#sv-role-debug-enabled');
                if (leverageToggle) {
                    this.ui.setTradeMode(leverageToggle.checked ? 'leverage' : 'spot');
                } else if (autoAdvanceToggle) {
                    this.app.setAutoAdvanceEnabled(autoAdvanceToggle.checked).catch(error => {
                        this.logger.error('切换实时自动推进失败:', error);
                        this.dependencies.win.toastr.error(`切换实时自动推进失败: ${error.message || error}`);
                    });
                } else if (roleAIToggle) {
                    this.setRoleAIEnabled(roleAIToggle.checked).then(() => {
                        this.dependencies.win.toastr.info(roleAIToggle.checked ? '角色决策流程已启用。' : '角色决策流程已关闭。');
                    }).catch(error => {
                        this.logger.error('切换角色决策流程失败:', error);
                        this.dependencies.win.toastr.error(`切换角色决策流程失败: ${error.message || error}`);
                    });
                } else if (roleDebugToggle) {
                    this.setRoleDebugEnabled(roleDebugToggle.checked).then(() => {
                        this.dependencies.win.toastr.info(roleDebugToggle.checked ? '角色截取调试已启用。' : '角色截取调试已关闭。');
                    }).catch(error => {
                        this.logger.error('切换角色截取调试失败:', error);
                        this.dependencies.win.toastr.error(`切换角色截取调试失败: ${error.message || error}`);
                    });
                }
            });

             sidebar.addEventListener('input', (event) => {
                const leverageSlider = event.target.closest('#sillyview-leverage-slider');
                if (leverageSlider) {
                     this.ui.selectedLeverage = parseInt(leverageSlider.value, 10);
                     this.ui.tradeView.updateLeverageInfo(this.ui.selectedLeverage);
                }
                const amountInput = event.target.closest('#sillyview-trade-amount');
                if (amountInput) {
                    const leverage = parseInt(this.parentDoc.getElementById('sillyview-leverage-slider')?.value || 1, 10);
                    this.ui.tradeView.updateLeverageInfo(leverage);
                    this.ui.tradeView.updateRiskPreview();
                }
             });
        }

        this.logger.log("主界面事件已绑定。");
    }
}
