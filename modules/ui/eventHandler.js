

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
                    const settings = this.ui.collectBackgroundAISettings();
                    await this.data.updateState(this.dependencies.config.world_book_keys.config, config => {
                        config.background_ai = settings;
                        return config;
                    });
                    this.dependencies.win.toastr.success("后台模型设置已保存。");
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
