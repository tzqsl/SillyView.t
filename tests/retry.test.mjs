import test from 'node:test';
import assert from 'node:assert/strict';

import { BackgroundAIService } from '../modules/services/backgroundAIService.js';
import { RoleDecisionService } from '../modules/services/roleDecisionService.js';
import { SillyViewApp } from '../modules/core/app.js';

for (const [name, prototype] of [
    ['background market AI', BackgroundAIService.prototype],
    ['roleplay AI', RoleDecisionService.prototype],
]) {
    test(`${name} gets three retries after the initial request`, async () => {
        let attempts = 0;
        const service = Object.create(prototype);
        service.retryDelayMs = 0;
        service.logger = { warn: () => {} };

        const result = await service._withRetries(async () => {
            attempts += 1;
            if (attempts < 4) throw new Error('temporary failure');
            return 'ok';
        }, name);

        assert.equal(result, 'ok');
        assert.equal(attempts, 4);
    });
}

test('roleplay wait toast is shown and cleared around frontend role generation', async () => {
    const calls = [];
    const toast = { id: 'role-wait' };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        pendingRoleTurnContext: { user_message_id: 9, user_content: '测试' },
        roleDecision: {
            running: false,
            isEnabled: () => true,
            run: async (_context, options) => {
                options.onStage('decision', 1, 4);
                options.onStage('observation', 2, 4);
                return { frontend_injection: '角色决策结果' };
            },
        },
        th: {
            injectPrompts: () => {},
        },
        logger: { success: () => {}, error: () => {} },
        dependencies: {
            win: {
                toastr: {
                    info: (...args) => {
                        calls.push(['show', ...args]);
                        return toast;
                    },
                    clear: value => calls.push(['clear', value]),
                },
            },
        },
        data: { saveRoleDecisionMemory: async () => true },
        events: { refreshRoleDebugWindow: () => {} },
    });

    await app.prepareFrontendRoleInjection('normal', {}, false);

    assert.equal(calls[0][0], 'show');
    assert.match(calls[0][1], /等待其余插件处理完毕/);
    assert.ok(calls.some(call => call[0] === 'show' && /决策 AI 思考中（当前尝试 1\/4 次）/.test(call[1])));
    assert.ok(calls.some(call => call[0] === 'show' && /角色 AI 查看账户与市场详情中（当前尝试 2\/4 次）/.test(call[1])));
    assert.deepEqual(calls.at(-1), ['clear', toast]);
});
