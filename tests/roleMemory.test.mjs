import test from 'node:test';
import assert from 'node:assert/strict';

import { DataManager } from '../modules/core/dataManager.js';

function createManager(initialBooks = {}) {
    const books = new Map(Object.entries(structuredClone(initialBooks)));
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        config: {
            role_memory: {
                worldbook_name: 'SillyView_role_memory',
                entry_key: 'sv_role_decision_latest',
            },
        },
        dependencies: {
            win: {
                _: { cloneDeep: value => structuredClone(value) },
            },
        },
        logger: { warn: () => {} },
        th: {
            getWorldbookNames: async () => [...books.keys()],
            createOrReplaceWorldbook: async (name, entries) => {
                books.set(name, structuredClone(entries));
            },
            getWorldbook: async name => structuredClone(books.get(name) || []),
            updateWorldbookWith: async (name, updater) => {
                const entries = structuredClone(books.get(name) || []);
                books.set(name, structuredClone(updater(entries)));
            },
        },
    });
    return { manager, books };
}

test('role memory worldbook is created with a disabled entry', async () => {
    const { manager, books } = createManager();

    await manager.ensureRoleDecisionMemoryWorldbook();

    const entries = books.get('SillyView_role_memory');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'sv_role_decision_latest');
    assert.equal(entries[0].enabled, false);
    assert.deepEqual(JSON.parse(entries[0].content), {
        version: 1,
        updated_at: 0,
        latest_run: null,
    });
});

test('role decision memory persists the complete latest run and stays disabled', async () => {
    const { manager, books } = createManager();
    const roleRun = {
        status: 'completed',
        completed_at: 99,
        raw_output: '<role_thought role="李四">我的心声</role_thought>',
        context: { user_content: '用户输入' },
        observation_rounds: [{ round: 1 }],
        trade_results: [{ executed: true }],
        frontend_injection: '注入内容',
    };

    assert.equal(await manager.saveRoleDecisionMemory(roleRun), true);
    const memory = await manager.getRoleDecisionMemory();
    const entry = books.get('SillyView_role_memory')[0];

    assert.deepEqual(memory.latest_run, roleRun);
    assert.equal(entry.enabled, false);
});
