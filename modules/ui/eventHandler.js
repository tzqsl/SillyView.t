

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
                models = await this._fetchModelsDirectly(settings);
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
                this.logger.log("用户同意创建世界书...");
                yesButton.disabled = true;
                yesButton.textContent = "正在创建...";
                this.data.createInitialWorldState();
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

    bindMainInterfaceEvents() {
        this.logger.log("正在绑定主界面事件...");
        
        const endTurnBtn = this.parentDoc.getElementById('sillyview-end-turn-btn');
        const quickModeToggle = this.parentDoc.getElementById('sillyview-quick-mode-toggle');
        const hourlyBtn = this.parentDoc.getElementById('sv-timescale-hourly');
        const dailyBtn = this.parentDoc.getElementById('sv-timescale-daily');
        const assetSelector = this.parentDoc.getElementById('sillyview-asset-selector');
        const syncBtn = this.parentDoc.getElementById('sillyview-sync-ai-btn');
        const nextHourBtn = this.parentDoc.getElementById('sillyview-next-hour-btn');
        const advanceDayBtn = this.parentDoc.getElementById('sillyview-advance-day-btn'); // New button
        const sidebar = this.parentDoc.querySelector('.sv-right-sidebar');
        
        // Time & Asset Controls
        if (endTurnBtn) endTurnBtn.addEventListener('click', async () => await this.app.commitAndAdvance());
        if (syncBtn) syncBtn.addEventListener('click', async () => await this.app.syncQuickModeWithAI());
        if (nextHourBtn) nextHourBtn.addEventListener('click', () => this.app.advanceQuickModeHour());
        if (advanceDayBtn) advanceDayBtn.addEventListener('click', () => this.app.commitAndAdvance()); // Correctly calls commitAndAdvance
        if (quickModeToggle) quickModeToggle.addEventListener('change', (event) => this.app.onQuickModeToggled(event.target.checked));
        if (hourlyBtn) hourlyBtn.addEventListener('click', () => this.ui.setTimeframe('HOURLY'));
        if (dailyBtn) dailyBtn.addEventListener('click', () => this.ui.setTimeframe('DAILY'));
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
                const saveBgAiBtn = target.closest('#sv-save-bg-ai-btn');
                const fetchBgAiModelsBtn = target.closest('#sv-fetch-bg-ai-models-btn');
                const bgAiModelOption = target.closest('.sv-bg-ai-model-option');

                if (tabButton) {
                    this.ui.switchSidebarTab(tabButton.dataset.tab);
                } else if (loanBtn) {
                    this.modals.showLoanModal('loan');
                } else if (repayBtn) {
                    this.modals.showLoanModal('repay');
                } else if (buyBtn) {
                    this.ui.initiateTrade('buy');
                } else if (sellBtn) {
                    this.ui.initiateTrade('sell');
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
                } else if (resetBtn) {
                    this.modals.showConfirmation(
                        `<h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--red-400);">确认重置？</h3><p>此操作将永久删除当前角色的所有SillyView数据并重新开始。此操作无法撤销。</p>`,
                        () => this.data.resetAllData()
                    );
                }
            });

            sidebar.addEventListener('change', (event) => {
                const leverageToggle = event.target.closest('#sillyview-leverage-mode-toggle');
                if (leverageToggle) {
                    this.ui.setTradeMode(leverageToggle.checked ? 'leverage' : 'spot');
                }
            });

             sidebar.addEventListener('input', (event) => {
                const leverageSlider = event.target.closest('#sillyview-leverage-slider');
                if (leverageSlider) {
                     this.ui.tradeView.updateLeverageInfo(parseInt(leverageSlider.value, 10));
                }
             });
        }

        this.logger.log("主界面事件已绑定。");
    }
}
