/**
 * SillyView - UI Renderer (v6.7 - Real-time Liquidation Fix)
 * Renders the main UI shell and orchestrates updates by delegating to specialized view modules.
 */
'use strict';

import { Logger } from '../logger.js';
import { SillyViewConfig } from '../config.js';
import { ChartManager } from './chartManager.js';

export class UIRenderer {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.parentDoc = dependencies.parentDoc;
        this.win = dependencies.win;
        this.data = dependencies.data;
        this.app = dependencies.app;
        this.positionCalculator = dependencies.positionCalculator;
        this.modals = dependencies.modals;

        // View Modules
        this.tradeView = dependencies.tradeView;
        this.assetsView = dependencies.assetsView;
        this.newsView = dependencies.newsView;
        this.logView = dependencies.logView;
        
        this.chartManager = new ChartManager(dependencies);
        this.avgCostLine = null;
        this.liquidationLine = null;

        this.isAnimating = false;
        this.isPanelVisible = false;
        this.isInitialized = false;
        this.currentAsset = 'EURUSD';
        this.currentTimeframe = 'HOURLY';
        this.currentChartType = 'candlestick';
        this.activeSidebarTab = 'trade'; // Default tab
        this.tradeMode = 'spot';
        
        this.liveAnimationPrice = null;
        this.animationFrameId = null;

        // New properties for idle fluctuation
        this.idleAnimationId = null;
        this.lastRealCandle = null;
    }

    async loadPanelHtml() {
        const body = this.win.document.body;
        if (body.querySelector('#sillyview-panel')) return;
        try {
            const scriptUrl = new URL(import.meta.url);
            const basePath = scriptUrl.pathname.substring(0, scriptUrl.pathname.lastIndexOf('/modules/ui'));
            const panelUrl = `${basePath}/panel.html`;
            const response = await fetch(panelUrl);
            if (!response.ok) throw new Error(`获取 panel.html 失败: ${response.statusText}`);
            const panelHtmlText = await response.text();
            const panelWrapper = this.parentDoc.createElement('div');
            panelWrapper.innerHTML = panelHtmlText;
            while (panelWrapper.firstChild) {
                body.appendChild(panelWrapper.firstChild);
            }
        } catch (error) {
            Logger.error('严重: 面板 HTML 加载失败:', error);
        }
    }
    
    handleResize() {
        if (this.chartManager.isInitialized()) {
            const chartContainer = this.parentDoc.getElementById('sillyview-chart-container');
            if(chartContainer) this.chartManager.handleResize(chartContainer.clientWidth, chartContainer.clientHeight);
        }
    }

    renderError(message) {
        const wrapper = this.parentDoc.getElementById('sillyview-content-wrapper');
        if (wrapper) wrapper.innerHTML = `<div style="margin: auto; text-align: center; padding: 2rem; color: var(--red-400);">${message}</div>`;
    }

    renderInitializationProgress({ title = '正在初始化 SillyView', detail = '准备中...', percent = 0, step = '' } = {}) {
        const wrapper = this.parentDoc.getElementById('sillyview-content-wrapper');
        if (!wrapper) return;

        const normalizedPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
        wrapper.innerHTML = `
            <div class="sv-init-screen">
                <div class="sv-init-panel">
                    <div class="sv-init-kicker">${step || '初始化'}</div>
                    <h2>${title}</h2>
                    <p>${detail}</p>
                    <div class="sv-init-progress-track" aria-label="初始化进度">
                        <div class="sv-init-progress-bar" style="width:${normalizedPercent}%;"></div>
                    </div>
                    <div class="sv-init-progress-meta">
                        <span>${normalizedPercent}%</span>
                        <span>后台 AI 可能需要几十秒，请勿重复点击</span>
                    </div>
                </div>
            </div>
        `;
    }

    renderCreationInterface() {
        const wrapper = this.parentDoc.getElementById('sillyview-content-wrapper');
        if (!wrapper) return;
        wrapper.innerHTML = `
            <div style="margin: auto; text-align: center; padding: 2rem;">
                <h2 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 1rem;">欢迎来到 SillyView</h2>
                <p style="margin-bottom: 1.5rem; color: var(--text-gray-400);">当前角色尚未初始化交易世界。是否要为其创建新的世界书条目？</p>
                <div style="display: flex; justify-content: center; gap: 1rem;">
                    <button id="sv-create-book-yes" class="sv-button sv-button-blue">是的，创建</button>
                    <button id="sv-create-book-no" class="sv-button" style="background-color: var(--bg-gray-600);">不了，谢谢</button>
                </div>
            </div>
        `;
        this.dependencies.events.bindCreationEvents();
    }
    
    renderMainInterface() {
        this.isInitialized = true;
        const wrapper = this.parentDoc.getElementById('sillyview-content-wrapper');
        if (!wrapper) { this.renderError("找不到UI包装器。"); return; }

        const availableAssets = this.data.getState(SillyViewConfig.world_book_keys.config)?.available_assets || [];
        const assetOptions = availableAssets.map(code => {
            const def = SillyViewConfig.asset_definitions[code];
            return `<option value="${code}" ${this.currentAsset === code ? 'selected' : ''}>${def.name} (${code})</option>`;
        }).join('');

        wrapper.innerHTML = `
            <div class="sv-main-layout">
                <header class="sv-header">
                    <div class="sv-header-left">
                         <h1 style="font-size: 1.25rem; font-weight: 700; color: var(--cyan-400);">SillyView</h1>
                         <select id="sillyview-asset-selector" class="sv-select">${assetOptions}</select>
                         <div id="sv-timescale-selector">
                            <button id="sv-timescale-minute">分</button>
                            <button id="sv-timescale-hourly">1H</button>
                            <button id="sv-timescale-daily">日</button>
                         </div>
                         <div style="display: flex; align-items: center; gap: 0.5rem; margin-left: 1.5rem;">
                             <span style="font-size: 0.75rem; color: var(--text-gray-400);" title="快速模式将使用纯随机数生成价格，而非AI叙事。">快速模式</span>
                             <label class="sv-toggle-switch">
                                 <input type="checkbox" id="sillyview-quick-mode-toggle">
                                 <span class="slider round"></span>
                             </label>
                         </div>
                    </div>
                    <div><span style="font-size: 0.875rem; color: var(--text-gray-300);">总资产: <span id="sillyview-total-assets">--</span> 信用点</span></div>
                </header>
                <main class="sv-main-content">
                    <div class="sv-left-panel">
                        <div class="sv-chart-stage">
                            <div id="sillyview-chart-container"></div>
                            <div id="sv-chart-type-selector" aria-label="图表类型">
                                <button id="sv-chart-candlestick" type="button" title="蜡烛图" aria-label="蜡烛图"><i class="fas fa-chart-bar"></i><span>K线</span></button>
                                <button id="sv-chart-line" type="button" title="折线图" aria-label="折线图"><i class="fas fa-chart-line"></i><span>折线</span></button>
                            </div>
                        </div>
                        <div class="sv-time-controls">
                            <h2 style="font-size:0.875rem; font-weight: 600; color:var(--text-gray-400);">时间控制:</h2>
                            <button id="sillyview-end-turn-btn" class="sv-button sv-button-blue">结束回合</button>
                            <button id="sillyview-next-5m-btn" class="sv-button sv-button-blue" style="display: none;">+5分</button>
                            <button id="sillyview-next-15m-btn" class="sv-button sv-button-blue" style="display: none;">+15分</button>
                            <button id="sillyview-next-30m-btn" class="sv-button sv-button-blue" style="display: none;">+30分</button>
                            <button id="sillyview-next-hour-btn" class="sv-button sv-button-blue" style="display: none;">下1小时</button>
                            <button id="sillyview-advance-day-btn" class="sv-button sv-button-blue" style="display: none;">推进一天</button>
                            <button id="sillyview-sync-ai-btn" class="sv-button sv-button-green" style="display: none;">与AI同步</button>
                        </div>
                    </div>
                    <aside id="sillyview-right-sidebar" class="sv-right-sidebar"></aside>
                </main>
            </div>
        `;

        this.initializeChart();
        this.renderRightSidebar(); 
        this.dependencies.events.bindMainInterfaceEvents();
        this.setTimeframe(this.currentTimeframe);
        this.setChartType(this.currentChartType);
        
        this.renderAll();
    }
    
    renderRightSidebar() {
        const sidebar = this.parentDoc.getElementById('sillyview-right-sidebar');
        if (!sidebar) return;

        sidebar.innerHTML = `
            <div class="sv-sidebar-tabs">
                <button class="sv-sidebar-tab" data-tab="trade">交易</button>
                <button class="sv-sidebar-tab" data-tab="assets">资产</button>
                <button class="sv-sidebar-tab" data-tab="news">新闻</button>
                <button class="sv-sidebar-tab" data-tab="log">记录</button>
                <button class="sv-sidebar-tab" data-tab="settings">设置</button>
            </div>
            <div class="sv-sidebar-content">
                <div id="sillyview-trade-tab-content" class="sv-sidebar-tab-content"></div>
                <div id="sillyview-assets-tab-content" class="sv-sidebar-tab-content"></div>
                <div id="sillyview-news-tab-content" class="sv-sidebar-tab-content"></div>
                <div id="sillyview-log-tab-content" class="sv-sidebar-tab-content"></div>
                <div id="sillyview-settings-tab-content" class="sv-sidebar-tab-content"></div>
            </div>
        `;
    }

    switchSidebarTab(tabId) {
        if (this.activeSidebarTab === tabId) return;
        this.activeSidebarTab = tabId;
        this.renderAll();
    }
    
    renderAll() {
        if (!this.isInitialized) return;
        
        this.updateUIVisibility();
        this.renderChartData();
        this.renderTotalAssets();
        
        const sidebar = this.parentDoc.getElementById('sillyview-right-sidebar');
        if (!sidebar) return;

        sidebar.querySelectorAll('.sv-sidebar-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === this.activeSidebarTab);
        });
        sidebar.querySelectorAll('.sv-sidebar-tab-content').forEach(content => {
            content.classList.toggle('active', content.id.includes(this.activeSidebarTab));
        });

        const activeContentPane = sidebar.querySelector(`.sv-sidebar-tab-content.active`);
        if (!activeContentPane) return;
        
        switch (this.activeSidebarTab) {
            case 'trade': this.tradeView.render(activeContentPane); break;
            case 'assets': this.assetsView.render(activeContentPane); break;
            case 'news': this.newsView.render(activeContentPane); break;
            case 'log': this.logView.render(activeContentPane); break;
            case 'settings': this.renderSettingsTab(activeContentPane); break;
        }
    }
    
    _escapeAttr(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _getBackgroundAISettings() {
        const configState = this.data.getState(SillyViewConfig.world_book_keys.config) || {};
        return {
            ...SillyViewConfig.background_ai_defaults,
            ...(configState.background_ai || {}),
        };
    }

    collectBackgroundAISettings() {
        const getValue = id => this.parentDoc.getElementById(id)?.value?.trim() || '';
        const enabled = Boolean(this.parentDoc.getElementById('sv-bg-ai-enabled')?.checked);
        const temperature = parseFloat(getValue('sv-bg-ai-temperature'));
        const maxTokens = parseInt(getValue('sv-bg-ai-max-tokens'), 10);

        return {
            enabled,
            source: getValue('sv-bg-ai-source') || 'openai',
            apiurl: getValue('sv-bg-ai-apiurl'),
            key: getValue('sv-bg-ai-key'),
            model: getValue('sv-bg-ai-model'),
            temperature: Number.isFinite(temperature) ? temperature : SillyViewConfig.background_ai_defaults.temperature,
            max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : SillyViewConfig.background_ai_defaults.max_tokens,
        };
    }

    renderSettingsTab(container) {
        const bgAI = this._getBackgroundAISettings();
        const sourceOptions = ['openai', 'claude', 'openrouter', 'google', 'mistral', 'cohere']
            .map(source => `<option value="${source}" ${bgAI.source === source ? 'selected' : ''}>${source}</option>`)
            .join('');

        container.innerHTML = `
            <div>
                <h3 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem;">游戏设置</h3>
                <div style="background-color: var(--bg-gray-900); padding: 1rem; border-radius: 0.375rem; border: 1px solid var(--bg-gray-700); margin-bottom: 1rem;">
                    <h4 style="font-weight: 600; color: var(--cyan-400); margin-bottom: 0.75rem;">后台市场模型</h4>
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:0.75rem;">
                        <span style="font-size:0.875rem; color:var(--text-gray-300);">使用自定义模型</span>
                        <span class="sv-toggle-switch">
                            <input type="checkbox" id="sv-bg-ai-enabled" ${bgAI.enabled ? 'checked' : ''}>
                            <span class="slider round"></span>
                        </span>
                    </label>
                    <div style="display:grid; gap:0.625rem;">
                        <label style="font-size:0.75rem; color:var(--text-gray-400);">API格式
                            <select id="sv-bg-ai-source" class="sv-select" style="width:100%; margin-top:0.25rem;">${sourceOptions}</select>
                        </label>
                        <label style="font-size:0.75rem; color:var(--text-gray-400);">API地址
                            <input id="sv-bg-ai-apiurl" class="sv-input" style="width:100%; margin-top:0.25rem;" value="${this._escapeAttr(bgAI.apiurl)}" placeholder="https://api.openai.com/v1">
                        </label>
                        <label style="font-size:0.75rem; color:var(--text-gray-400);">API Key
                            <input id="sv-bg-ai-key" type="password" class="sv-input" style="width:100%; margin-top:0.25rem;" value="${this._escapeAttr(bgAI.key)}">
                        </label>
                        <label style="font-size:0.75rem; color:var(--text-gray-400);">模型
                            <input id="sv-bg-ai-model" class="sv-input" style="width:100%; margin-top:0.25rem;" value="${this._escapeAttr(bgAI.model)}" placeholder="gpt-4o-mini / claude-3-5-sonnet-latest">
                        </label>
                        <button id="sv-fetch-bg-ai-models-btn" class="sv-button" style="width:100%; background-color: var(--bg-gray-700);">获取模型</button>
                        <div id="sv-bg-ai-model-list" style="display:grid; gap:0.375rem; max-height:10rem; overflow:auto;"></div>
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.625rem;">
                            <label style="font-size:0.75rem; color:var(--text-gray-400);">温度
                                <input id="sv-bg-ai-temperature" type="number" min="0" max="2" step="0.1" class="sv-input" style="width:100%; margin-top:0.25rem;" value="${this._escapeAttr(bgAI.temperature)}">
                            </label>
                            <label style="font-size:0.75rem; color:var(--text-gray-400);">最大Token
                                <input id="sv-bg-ai-max-tokens" type="number" min="64" step="1" class="sv-input" style="width:100%; margin-top:0.25rem;" value="${this._escapeAttr(bgAI.max_tokens)}">
                            </label>
                        </div>
                        <button id="sv-save-bg-ai-btn" class="sv-button sv-button-blue" style="width:100%;">保存后台模型设置</button>
                    </div>
                </div>
                <div style="background-color: var(--bg-gray-900); padding: 1rem; border-radius: 0.375rem; border: 1px solid var(--red-500);">
                    <h4 style="font-weight: 600; color: var(--red-400);">危险区域</h4>
                    <p style="font-size: 0.875rem; color: var(--text-gray-400); margin-top: 0.5rem; margin-bottom: 1rem;">
                        此操作将永久删除当前角色的所有 SillyView 市场、资产和账户数据并重新开始新游戏，但会保留后台模型设置。
                    </p>
                    <button id="sv-reset-data-btn" class="sv-button sv-button-red w-full" style="width:100%;">重置所有数据</button>
                </div>
            </div>
        `;
    }

    initializeChart() {
        const chartContainer = this.parentDoc.getElementById('sillyview-chart-container');
        this.chartManager.initialize(chartContainer);
        
        this.chartManager.subscribeCrosshairMove(param => {
            const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.currentAsset}`);
            const candleData = param.time !== undefined && param.time !== null
                ? this._getKlineDataForTimeframe(assetData).find(candle => candle.time === param.time)
                : null;
            if (this.activeSidebarTab === 'trade') {
                this._updateDataWindow(candleData);
            }
        });
    }

    _updateDataWindow(candleData) {
        const dataOpen = this.parentDoc.getElementById('sillyview-data-open');
        const dataHigh = this.parentDoc.getElementById('sillyview-data-high');
        const dataLow = this.parentDoc.getElementById('sillyview-data-low');
        const dataClose = this.parentDoc.getElementById('sillyview-data-close');
        const dataVolume = this.parentDoc.getElementById('sillyview-data-volume');
    
        if (!dataOpen) return;

        if (candleData) {
            dataOpen.textContent = candleData.open.toFixed(4);
            dataHigh.textContent = candleData.high.toFixed(4);
            dataLow.textContent = candleData.low.toFixed(4);
            dataClose.textContent = candleData.close.toFixed(4);
            
            const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.currentAsset}`);
            if(assetData) {
                const sourceData = this._getKlineDataForTimeframe(assetData);
                const fullCandle = sourceData.find(c => c.time === candleData.time);
                dataVolume.textContent = fullCandle ? fullCandle.volume.toLocaleString() : '-';
            }
            this.updatePnlAndPriceLines(candleData.close);
        } else {
            this.tradeView.updateDataWindowWithLastCandle();
        }
    }

    _getKlineDataForTimeframe(assetData) {
        if (!assetData) return [];
        if (this.currentTimeframe === 'MINUTE') return assetData.kline_minute || [];
        if (this.currentTimeframe === 'DAILY') return assetData.kline_daily || [];
        return assetData.kline_hourly || [];
    }
    
    renderChartData() {
        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.currentAsset}`);
        if (!assetData) return;
        const klineData = this._getKlineDataForTimeframe(assetData);
        
        if (klineData.length === 0) {
            this.chartManager.setData([], []);
            return;
        }

        const volumeData = klineData.map(d => ({ 
            time: d.time, 
            value: d.volume, 
            color: d.close > d.open ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)' 
        }));
        
        this.chartManager.setData(klineData, volumeData);
        if (klineData.length > 0) {
            this.chartManager.scrollToPosition(klineData.length - 1, false);
        }
        this.updatePnlAndPriceLines(klineData[klineData.length - 1].close);
        this._startIdleFluctuation(); 
    }
    
    updatePnlAndPriceLines(currentPrice) {
        if (!this.isInitialized || !this.parentDoc.getElementById('sillyview-panel')?.classList.contains('visible')) return;

        const dataPnl = this.parentDoc.getElementById('sillyview-data-pnl');
        const dataPnlDetails = this.parentDoc.getElementById('sillyview-data-pnl-details');
    
        if (this.avgCostLine) this.chartManager.removePriceLine(this.avgCostLine);
        if (this.liquidationLine) this.chartManager.removePriceLine(this.liquidationLine);
        this.avgCostLine = null;
        this.liquidationLine = null;

        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        const position = this.positionCalculator.calculate(this.currentAsset, portfolio);
        
        if (position.totalAmount > 0) {
            const pnl = position.type === 'long' 
                ? (currentPrice - position.avgEntryPrice) * position.totalShares
                : (position.avgEntryPrice - currentPrice) * position.totalShares;

            const pnlPercent = position.totalAmount > 0 ? (pnl / position.totalAmount) * 100 : 0;
            const pnlColorClass = pnl >= 0 ? 'var(--green-400)' : 'var(--red-400)';
            const sign = pnl >= 0 ? '+' : '';
            
            if(dataPnl) dataPnl.innerHTML = `<span style="color:${pnlColorClass};">${sign}${pnl.toFixed(2)}</span>`;
            if(dataPnlDetails) dataPnlDetails.innerHTML = `<span style="color:${pnlColorClass};">(${sign}${pnlPercent.toFixed(2)}%)</span>`;
            
            const title = `仓位: ${position.totalAmount.toFixed(2)} @ ${position.avgEntryPrice.toFixed(4)} | 盈亏: ${sign}${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(2)}%)`;
            const color = pnl >= 0 ? '#22c55e' : '#ef4444';
            
            this.avgCostLine = this.chartManager.createPriceLine({ 
                price: position.avgEntryPrice, 
                title: title, 
                color: color, 
                lineWidth: 2, 
                lineStyle: this.win.LightweightCharts.LineStyle.Dashed, 
                axisLabelVisible: true 
            });
            
            if (position.isLeveraged && position.liquidationPrice > 0) {
                 const liqColor = position.type === 'long' ? '#facc15' : '#a855f7';
                 this.liquidationLine = this.chartManager.createPriceLine({ 
                    price: position.liquidationPrice, 
                    title: `强平 @ ${position.liquidationPrice.toFixed(4)}`, 
                    color: liqColor, 
                    lineWidth: 2, 
                    lineStyle: this.win.LightweightCharts.LineStyle.Dotted, 
                    axisLabelVisible: true 
                });
            }

        } else {
            if(dataPnl) dataPnl.textContent = '-';
            if(dataPnlDetails) dataPnlDetails.textContent = '';
        }
    }
    
    renderTotalAssets() {
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        if (!portfolio) return;
        
        const totalValue = this.assetsView.calculateTotalAssetValue(portfolio) + portfolio.cash - (portfolio.debt || 0);
        const totalAssetsEl = this.parentDoc.getElementById('sillyview-total-assets');
        if (totalAssetsEl) totalAssetsEl.textContent = totalValue.toFixed(2);
    }

    _readRiskControls(action, currentPrice) {
        if (action.startsWith('close')) return null;

        const takeProfitEl = this.parentDoc.getElementById('sillyview-take-profit');
        const stopLossEl = this.parentDoc.getElementById('sillyview-stop-loss');
        const readOptionalPrice = (el, label) => {
            const raw = el?.value?.trim();
            if (!raw) return null;
            const value = parseFloat(raw);
            if (!Number.isFinite(value) || value <= 0) {
                this.win.toastr.error(`请输入有效的${label}。`);
                return undefined;
            }
            return value;
        };

        const takeProfit = readOptionalPrice(takeProfitEl, '止盈价');
        if (takeProfit === undefined) return undefined;
        const stopLoss = readOptionalPrice(stopLossEl, '止损价');
        if (stopLoss === undefined) return undefined;

        const isLong = action.endsWith('long');
        if (takeProfit !== null) {
            const invalid = isLong ? takeProfit <= currentPrice : takeProfit >= currentPrice;
            if (invalid) {
                this.win.toastr.error(isLong ? '做多止盈价必须高于当前价。' : '做空止盈价必须低于当前价。');
                return undefined;
            }
        }
        if (stopLoss !== null) {
            const invalid = isLong ? stopLoss >= currentPrice : stopLoss <= currentPrice;
            if (invalid) {
                this.win.toastr.error(isLong ? '做多止损价必须低于当前价。' : '做空止损价必须高于当前价。');
                return undefined;
            }
        }

        return { take_profit: takeProfit, stop_loss: stopLoss };
    }

    initiateTrade(type) {
        if (this.isAnimating) return;
        
        const position = this.positionCalculator.calculate(this.currentAsset, this.data.getState(SillyViewConfig.world_book_keys.player_portfolio));
        
        let action = '';
        if (type === 'buy') {
            if (position.type === 'short') action = 'close_short';
            else if (position.type === 'long') action = 'add_long';
            else action = 'open_long';
        } else { // sell
            if (position.type === 'long') action = 'close_long';
            else if (position.type === 'short') action = 'add_short';
            else action = 'open_short';
        }

        let amount;
        if (action.startsWith('close')) {
            amount = position.totalAmount; 
        } else {
            const amountEl = this.parentDoc.getElementById('sillyview-trade-amount');
            if(!amountEl) return;
            amount = parseFloat(amountEl.value);
            if (isNaN(amount) || amount <= 0) { this.win.toastr.error("请输入有效的交易金额。"); return; }
        }
        
        const leverage = this.tradeMode === 'leverage' ? parseInt(this.parentDoc.getElementById('sillyview-leverage-slider')?.value || 1) : 1;
        
        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.currentAsset}`);
        const currentKlineData = this._getKlineDataForTimeframe(assetData);
        const lastCandle = currentKlineData.slice(-1)[0] || assetData.kline_minute?.slice(-1)[0] || assetData.kline_hourly.slice(-1)[0];
        const currentPrice = this.isAnimating && this.liveAnimationPrice !== null ? this.liveAnimationPrice : (assetData.current_price ?? lastCandle.close);
        const riskControls = this._readRiskControls(action, currentPrice);
        if (riskControls === undefined) return;
        
        this.app.executeTrade(action, amount, this.currentAsset, currentPrice, leverage, riskControls);
    }

    updateUIVisibility() {
        const isQuickMode = this.data.isQuickModeEnabled();
        const market = this.data.getState(SillyViewConfig.world_book_keys.global_market);
        const isKeyMoment = market && market.remaining_candles <= 0;

        const endTurnBtn = this.parentDoc.getElementById('sillyview-end-turn-btn');
        const minuteBtns = [
            this.parentDoc.getElementById('sillyview-next-5m-btn'),
            this.parentDoc.getElementById('sillyview-next-15m-btn'),
            this.parentDoc.getElementById('sillyview-next-30m-btn'),
        ];
        const nextHourBtn = this.parentDoc.getElementById('sillyview-next-hour-btn');
        const advanceDayBtn = this.parentDoc.getElementById('sillyview-advance-day-btn');
        const syncBtn = this.parentDoc.getElementById('sillyview-sync-ai-btn');
        const quickModeToggle = this.parentDoc.getElementById('sillyview-quick-mode-toggle');
    
        if (isKeyMoment) {
            if(endTurnBtn) endTurnBtn.style.display = 'block';
            minuteBtns.forEach(btn => { if (btn) btn.style.display = 'none'; });
            if(nextHourBtn) nextHourBtn.style.display = 'none';
            if(advanceDayBtn) advanceDayBtn.style.display = 'none';
            if(syncBtn) syncBtn.style.display = 'none';
        } else if (isQuickMode) {
            if(endTurnBtn) endTurnBtn.style.display = 'none';
            minuteBtns.forEach(btn => { if (btn) btn.style.display = 'block'; });
            if(nextHourBtn) nextHourBtn.style.display = 'block';
            if(advanceDayBtn) advanceDayBtn.style.display = 'block';
            if(syncBtn) syncBtn.style.display = 'block';
        } else { // AI Mode
            if(endTurnBtn) endTurnBtn.style.display = 'block';
            minuteBtns.forEach(btn => { if (btn) btn.style.display = 'none'; });
            if(nextHourBtn) nextHourBtn.style.display = 'none';
            if(advanceDayBtn) advanceDayBtn.style.display = 'none';
            if(syncBtn) syncBtn.style.display = 'none';
        }
        
        if (quickModeToggle) {
            quickModeToggle.checked = isQuickMode;
        }
    }
    
    async handleAiResponse(newCandles, msg, assetCode, minuteCandles = []) {
        const shouldAnimateHourlyCandles = assetCode === this.currentAsset && this.currentTimeframe === 'HOURLY';

        if (shouldAnimateHourlyCandles) {
            await this.animateCandles(newCandles, 2000); 
        }
        
        await this.data.updateAssetCandles(assetCode, newCandles, minuteCandles);
        const newTimeIndex = newCandles.slice(-1)[0].time;
        const newMinuteIndex = minuteCandles.length > 0 ? minuteCandles[minuteCandles.length - 1].time : newTimeIndex * 60;
        await this.data.updateState(SillyViewConfig.world_book_keys.global_market, market => {
            market.current_time_index = Math.max(market.current_time_index || 0, newTimeIndex);
            market.minute_time_index = Math.max(market.minute_time_index || 0, newMinuteIndex);
            return market;
        });

        const assetDef = SillyViewConfig.asset_definitions[assetCode];
        await this.data.aggregateHourlyToDaily(assetCode, assetDef.trading_hours_per_day);
        
        if (assetCode === this.currentAsset) {
            this.renderAll();
        }
    }
    
    switchAsset(assetCode) {
        if (this.currentAsset === assetCode) return;
        this.currentAsset = assetCode;
        if (this.avgCostLine) { this.chartManager.removePriceLine(this.avgCostLine); this.avgCostLine = null; }
        if (this.liquidationLine) { this.chartManager.removePriceLine(this.liquidationLine); this.liquidationLine = null; }
        this.renderAll();
    }

    setTimeframe(timeframe) {
        const shouldRender = this.currentTimeframe !== timeframe;
        this.currentTimeframe = timeframe;
        const minuteBtn = this.parentDoc.getElementById('sv-timescale-minute');
        const hourlyBtn = this.parentDoc.getElementById('sv-timescale-hourly');
        const dailyBtn = this.parentDoc.getElementById('sv-timescale-daily');
        if (minuteBtn && hourlyBtn && dailyBtn) {
            minuteBtn.classList.toggle('active-timescale', timeframe === 'MINUTE');
            hourlyBtn.classList.toggle('active-timescale', timeframe === 'HOURLY');
            dailyBtn.classList.toggle('active-timescale', timeframe === 'DAILY');
        }
        if (shouldRender) this.renderChartData();
    }

    setChartType(chartType) {
        const normalizedType = chartType === 'line' ? 'line' : 'candlestick';
        const shouldRender = this.currentChartType !== normalizedType;
        this.currentChartType = normalizedType;
        this.chartManager.setChartType(normalizedType);

        const candlestickBtn = this.parentDoc.getElementById('sv-chart-candlestick');
        const lineBtn = this.parentDoc.getElementById('sv-chart-line');
        if (candlestickBtn && lineBtn) {
            candlestickBtn.classList.toggle('active-chart-type', normalizedType === 'candlestick');
            lineBtn.classList.toggle('active-chart-type', normalizedType === 'line');
            candlestickBtn.setAttribute('aria-pressed', String(normalizedType === 'candlestick'));
            lineBtn.setAttribute('aria-pressed', String(normalizedType === 'line'));
        }

        if (!shouldRender) return;
        if (this.avgCostLine) this.chartManager.removePriceLine(this.avgCostLine);
        if (this.liquidationLine) this.chartManager.removePriceLine(this.liquidationLine);
        this.avgCostLine = null;
        this.liquidationLine = null;
        this.renderChartData();
    }

    setTradeMode(mode) {
        this.tradeMode = mode;
        this.renderAll();
    }
    
    async animateCandles(candles, duration) {
        this._stopIdleFluctuation();
        if (this.isAnimating) return;
        this.isAnimating = true;
        this.tradeView.updateActionButtonsState(true, false);
    
        for (const candle of candles) {
            await this._animateSingleCandle(candle, duration / candles.length);
            
            if (!this.isAnimating) {
                this.logger.warn("动画循环因爆仓而中断。");
                break;
            }

            this.chartManager.update(candle, { time: candle.time, value: candle.volume, color: candle.close > candle.open ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)' });
        }
    
        const wasStopped = !this.isAnimating;
        this.isAnimating = false;
        this.liveAnimationPrice = null;
        this.tradeView.updateActionButtonsState(false, false);
        
        if (!wasStopped) {
            this._startIdleFluctuation();
        }
    }
    
    async _animateSingleCandle(targetCandle, duration) {
        return new Promise(resolve => {
            const startTime = performance.now();
            const { open, high, low, close } = targetCandle;
            const assetCode = this.currentAsset;
            const path = (close > open) ? [open, low, high, close] : [open, high, low, close];
            const segments = path.length - 1;
            const segmentDuration = duration / segments;
    
            const animate = async (currentTime) => {
                const elapsedTime = currentTime - startTime;

                if (elapsedTime >= duration) {
                    this.liveAnimationPrice = targetCandle.close;
                    this.chartManager.update(targetCandle);
                    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
                    this.animationFrameId = null;
                    resolve();
                    return;
                }
                
                const currentSegmentIndex = Math.floor(elapsedTime / segmentDuration);
                const segmentStartTime = currentSegmentIndex * segmentDuration;
                const segmentElapsedTime = elapsedTime - segmentStartTime;
                const segmentProgress = Math.min(1, segmentElapsedTime / segmentDuration);
                const startPrice = path[currentSegmentIndex];
                const endPrice = path[currentSegmentIndex + 1];
                const newPrice = startPrice + (endPrice - startPrice) * segmentProgress;
                this.liveAnimationPrice = newPrice;
    
                const wasLiquidated = await this.app._checkLiquidations({ [assetCode]: newPrice });
                if (wasLiquidated) {
                    this.logger.warn(`清算事件已触发，正在停止动画...`);
                    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
                    this.animationFrameId = null;
                    resolve();
                    return;
                }

                let currentHigh = open, currentLow = open;
                for(let i = 0; i <= currentSegmentIndex; i++) {
                    currentHigh = Math.max(currentHigh, path[i]);
                    currentLow = Math.min(currentLow, path[i]);
                }
                currentHigh = Math.max(currentHigh, newPrice);
                currentLow = Math.min(currentLow, newPrice);
                
                const candleForUpdate = { time: targetCandle.time, open, close: newPrice, high: currentHigh, low: currentLow };
                const volumeForUpdate = { time: targetCandle.time, value: targetCandle.volume * (elapsedTime / duration), color: targetCandle.close > targetCandle.open ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)'};
    
                this.chartManager.update(candleForUpdate, volumeForUpdate);
                if(this.activeSidebarTab === 'trade') this.updatePnlAndPriceLines(newPrice);
                this.animationFrameId = requestAnimationFrame(animate);
            };
    
            if(this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = requestAnimationFrame(animate);
        });
    }

    _startIdleFluctuation() {
        this._stopIdleFluctuation();
        if (!this.chartManager.isInitialized()) return;

        const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${this.currentAsset}`);
        if (!assetData) return;
        const klineData = this._getKlineDataForTimeframe(assetData);
        if (klineData.length === 0) return;

        this.lastRealCandle = { ...klineData[klineData.length - 1] };
        
        const fluctuate = () => {
            if (this.isAnimating || !this.lastRealCandle) {
                this._stopIdleFluctuation();
                return;
            }

            const fluctuationAmplitude = this.lastRealCandle.close * 0.0005; // 0.05% fluctuation
            const offset = Math.sin(Date.now() / 300) * fluctuationAmplitude;
            
            const tempCandle = { ...this.lastRealCandle };
            tempCandle.close = this.lastRealCandle.close + offset;
            tempCandle.high = Math.max(this.lastRealCandle.high, tempCandle.close);
            tempCandle.low = Math.min(this.lastRealCandle.low, tempCandle.close);

            this.chartManager.update(tempCandle);
            if(this.activeSidebarTab === 'trade') this.updatePnlAndPriceLines(tempCandle.close);

            this.idleAnimationId = requestAnimationFrame(fluctuate);
        };
        this.idleAnimationId = requestAnimationFrame(fluctuate);
    }

    _stopIdleFluctuation() {
        if (this.idleAnimationId) {
            cancelAnimationFrame(this.idleAnimationId);
            this.idleAnimationId = null;

            // Restore the chart to the actual last candle state
            if (this.lastRealCandle) {
                this.chartManager.update(this.lastRealCandle);
                if(this.activeSidebarTab === 'trade') this.updatePnlAndPriceLines(this.lastRealCandle.close);
            }
        }
    }
}
