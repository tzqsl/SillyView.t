/**
 * SillyView - Main Entry Point (v6.1 - Dependency Injection Fix)
 * This script initializes the extension and handles the UI-driven data loading.
 */
'use strict';

import { SillyViewApp } from './modules/core/app.js';
import { Logger } from './modules/logger.js';
import { SillyViewConfig } from './modules/config.js';
import { DataManager } from './modules/core/dataManager.js';
import { CommandParser } from './modules/core/commandParser.js';
import { AIDirector } from './modules/services/aiDirector.js';
import { BackgroundAIService } from './modules/services/backgroundAIService.js';
import { MarketSimulator } from './modules/services/marketSimulator.js';
import { PositionCalculator } from './modules/services/positionCalculator.js';
import { RoleDecisionService } from './modules/services/roleDecisionService.js';
import { UIRenderer } from './modules/ui/uiRenderer.js';
import { EventHandler } from './modules/ui/eventHandler.js';
import { Modals } from './modules/ui/modals.js';
import { TradeView } from './modules/ui/tradeView.js';
import { AssetsView } from './modules/ui/assetsView.js';
import { NewsView } from './modules/ui/newsView.js';
import { LogView } from './modules/ui/logView.js';
import { createSillyViewPublicAPI } from './modules/services/publicApi.js';

/**
 * Loads an external script dynamically and returns a promise that resolves when it's loaded.
 * @param {string} url The URL of the script to load.
 * @param {Document} doc The document to append the script to (usually parent document).
 * @returns {Promise<boolean>} A promise that resolves to true on success, or rejects on error.
 */
async function loadScript(url, doc) {
    return new Promise((resolve, reject) => {
        if (doc.querySelector(`script[src="${url}"]`)) {
            resolve(true);
            return;
        }
        const script = doc.createElement('script');
        script.src = url;
        script.onload = () => resolve(true);
        script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
        doc.head.appendChild(script);
    });
}

// 1. Wait for SillyTavern's APIs to be ready
const apiReadyInterval = setInterval(async () => {
    if (window.parent && window.parent.SillyTavern && window.parent.TavernHelper && window.parent.jQuery && window.parent.toastr && window.parent.SillyTavern.getContext) {
        clearInterval(apiReadyInterval);
        await mainInitialize();
    }
}, 250);

async function mainInitialize() {
    Logger.log("SillyView APIs ready. Initializing App (v6.1 - DI Fix)...");

    try {
        await loadScript('https://cdn.jsdelivr.net/npm/lightweight-charts@4.0.1/dist/lightweight-charts.standalone.production.js', window.parent.document);
        Logger.success("TradingView Lightweight Charts 库加载成功。");
        
        const app = new SillyViewApp();

        const parentWin = window.parent;
        const baseDependencies = {
            app,
            win: parentWin,
            parentDoc: parentWin.document,
            st: parentWin.SillyTavern,
            th: parentWin.TavernHelper,
            st_context: parentWin.SillyTavern.getContext(),
            logger: Logger,
            config: SillyViewConfig,
        };

        const commandParser = new CommandParser();
        const positionCalculator = new PositionCalculator(baseDependencies);
        const data = new DataManager({ ...baseDependencies, positionCalculator });
        const marketSimulator = new MarketSimulator({ ...baseDependencies, data });
        const backgroundAI = new BackgroundAIService({ ...baseDependencies, data });
        const roleDecision = new RoleDecisionService({ ...baseDependencies, data, commandParser });

        const tradeView = new TradeView({ ...baseDependencies, data, positionCalculator });
        const assetsView = new AssetsView({ ...baseDependencies, data, positionCalculator });
        const newsView = new NewsView({ ...baseDependencies, data });
        const logView = new LogView({ ...baseDependencies, data });
        const modals = new Modals({ ...baseDependencies, data, positionCalculator });
        
        const ui = new UIRenderer({ 
            ...baseDependencies, 
            data,
            positionCalculator,
            modals,
            tradeView,
            assetsView,
            newsView,
            logView,
        });

        const aiDirector = new AIDirector({ ...baseDependencies, data, positionCalculator });
        aiDirector.ui = ui;

        const events = new EventHandler({ ...baseDependencies, data, ui, modals, positionCalculator, roleDecision });

        const publicApi = createSillyViewPublicAPI({
            data,
            roleDecision,
            config: SillyViewConfig,
        });
        parentWin.SillyViewAPI = publicApi;
        window.addEventListener('pagehide', () => {
            if (parentWin.SillyViewAPI === publicApi) delete parentWin.SillyViewAPI;
        }, { once: true });
        
        app.init({
            ...baseDependencies,
            data,
            ui,
            events,
            commandParser,
            aiDirector,
            backgroundAI,
            roleDecision,
            marketSimulator,
            positionCalculator,
            modals,
            tradeView,
            assetsView,
            newsView,
            logView,
            logger: Logger,
        });

    } catch (error) {
        Logger.error("CRITICAL: Failed to initialize SillyView:", error);
    }
}
