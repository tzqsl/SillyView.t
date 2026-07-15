
/**
 * SillyView - Event Handler (v4.2 - Resize Fix)
 * Binds events to dynamically created UI elements and handles global events like window resize.
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
            
            if (this.ui.isPanelVisible && !this.ui.isInitialized) {
                this.logger.log("面板首次变为可见，正在加载初始状态...");
                this.data.loadInitialState();
            } else if (this.ui.isPanelVisible) {
                this.logger.log("面板重新变为可见。");
                this.ui.handleResize();
            }
        });

        this.logger.log("悬浮入口按钮已创建并绑定核心事件。");
    }

    bindResizeHandler() {
        this.dependencies.win.addEventListener('resize', () => {
            clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                if (this.ui.isPanelVisible && this.ui.chart) {
                    this.logger.log("窗口大小改变，正在调整UI...");
                    this.ui.handleResize();
                }
            }, 150); // Debounce resize event
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

        const buyBtn = this.parentDoc.getElementById('sillyview-buy-btn');
        const sellBtn = this.parentDoc.getElementById('sillyview-sell-btn');
        const endTurnBtn = this.parentDoc.getElementById('sillyview-end-turn-btn');
        const quickModeToggle = this.parentDoc.getElementById('sillyview-quick-mode-toggle');
        const hourlyBtn = this.parentDoc.getElementById('sv-timescale-hourly');
        const dailyBtn = this.parentDoc.getElementById('sv-timescale-daily');
        const assetSelector = this.parentDoc.getElementById('sillyview-asset-selector');
        const syncBtn = this.parentDoc.getElementById('sillyview-sync-ai-btn');


        if (buyBtn) {
            buyBtn.addEventListener('click', () => this.ui.initiateTrade('buy'));
        }
        if (sellBtn) {
            sellBtn.addEventListener('click', () => this.ui.initiateTrade('sell'));
        }
        if (endTurnBtn) {
            endTurnBtn.addEventListener('click', () => this.app.commitAndAdvance());
        }
        if (syncBtn) {
            syncBtn.addEventListener('click', () => this.app.syncQuickModeWithAI());
        }
        
        if (quickModeToggle) {
            quickModeToggle.addEventListener('change', (event) => {
                const isEnabled = event.target.checked;
                this.app.onQuickModeToggled(isEnabled);
                this.ui.updateEndTurnButtonText(isEnabled);
            });
        }

        if (hourlyBtn) {
            hourlyBtn.addEventListener('click', () => this.ui.setTimeframe('HOURLY'));
        }
        if (dailyBtn) {
            dailyBtn.addEventListener('click', () => this.ui.setTimeframe('DAILY'));
        }
        
        if (assetSelector) {
            assetSelector.addEventListener('change', (event) => {
                this.ui.switchAsset(event.target.value);
            });
        }

        this.logger.log("主界面事件已绑定。");
    }
}
