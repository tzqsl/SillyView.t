/**
 * SillyView - Modals Service
 * A centralized service for creating and managing all modal dialogs.
 */
'use strict';

import { SillyViewConfig } from "../config.js";

export class Modals {
    constructor(dependencies) {
        this.parentDoc = dependencies.parentDoc;
        this.win = dependencies.win;
        this.data = dependencies.data;
        this.positionCalculator = dependencies.positionCalculator;
    }

    showConfirmation(message, onConfirm) {
        const modal = this._createModal(message, '确认', () => {
            onConfirm();
            this._removeModal(modal);
        });
        this.parentDoc.body.appendChild(modal);
    }

    showLoanModal(type) {
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio);
        if (!portfolio) return;

        const { cash, debt = 0 } = portfolio;
        const totalAssetValue = this._calculateTotalAssetValue(portfolio);
        const netWorth = cash + totalAssetValue;
        
        const maxLoan = netWorth * SillyViewConfig.loan_config.credit_limit_multiplier - debt;
        const maxRepay = Math.min(cash, debt);

        const isLoan = type === 'loan';
        const title = isLoan ? '申请贷款' : '偿还贷款';
        const maxAmount = isLoan ? maxLoan : maxRepay;
        const buttonText = isLoan ? '确认贷款' : '确认还款';

        const message = `
            <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">${title}</h3>
            <p style="margin-bottom: 0.5rem;">最大可${isLoan ? '贷' : '还'}金额: <span class="font-mono">${maxAmount.toFixed(2)}</span></p>
            <p style="margin-bottom: 1rem; font-size:0.75rem; color: var(--text-gray-400);">每日利息为 0.1%。</p>
            <input type="number" id="sv-loan-amount" placeholder="输入金额" class="sv-input" max="${maxAmount}" min="0">
        `;
        
        const modal = this._createModal(message, buttonText, () => {
            const amountInput = this.parentDoc.getElementById('sv-loan-amount');
            const amount = parseFloat(amountInput.value);

            if (isNaN(amount) || amount <= 0) { this.win.toastr.error("请输入有效金额。"); return; }
            if (amount > maxAmount) { this.win.toastr.error(`金额超过上限。`); return; }

            if (isLoan) {
                this.data.takeLoan(amount);
            } else {
                this.data.repayLoan(amount);
            }
            this._removeModal(modal);
        });
        this.parentDoc.body.appendChild(modal);
    }

    _createModal(message, confirmText, onConfirm) {
        this._removeModal(); // Remove any existing modal first

        const modal = this.parentDoc.createElement('div');
        modal.className = 'sv-modal-overlay';
        modal.innerHTML = `
            <div class="sv-modal-content">
                ${message}
                <div style="display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.5rem;">
                    <button id="sv-modal-cancel" class="sv-button" style="background-color: var(--bg-gray-600);">取消</button>
                    <button id="sv-modal-ok" class="sv-button sv-button-blue">${confirmText}</button>
                </div>
            </div>
        `;

        modal.querySelector('#sv-modal-ok').addEventListener('click', onConfirm);
        modal.querySelector('#sv-modal-cancel').addEventListener('click', () => this._removeModal(modal));
        modal.addEventListener('click', (e) => { if (e.target === modal) this._removeModal(modal); });

        return modal;
    }

    _removeModal(modal = null) {
        const modalToRemove = modal || this.parentDoc.querySelector('.sv-modal-overlay');
        if (modalToRemove) {
            modalToRemove.remove();
        }
    }
    
    // Helper to calculate total asset value for loan calculations.
    _calculateTotalAssetValue(portfolio) {
         return Object.keys(portfolio.assets || {}).reduce((sum, assetCode) => {
            return sum + Object.values(this.positionCalculator.calculateAll(assetCode, portfolio)).reduce((assetSum, position) => {
                if (position.totalAmount <= 0) return assetSum;
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${assetCode}`);
                const lastPrice = assetData?.current_price ?? 0;
                const pnl = position.type === 'short'
                    ? (position.avgEntryPrice - lastPrice) * position.totalShares
                    : (lastPrice - position.avgEntryPrice) * position.totalShares;
                return assetSum + position.totalAmount + pnl;
            }, 0);
        }, 0);
    }
}
