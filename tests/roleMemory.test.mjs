import test from 'node:test';
import assert from 'node:assert/strict';

import { DataManager } from '../modules/core/dataManager.js';

const MEMORY_ENTRY = 'sv_role_decision_latest';
const CONTROL_BOOK = 'SillyView_accounts';
const LEGACY_BOOK = 'SillyView_role_memory';

function createManager(initialBooks = {}) {
    const books = new Map(Object.entries(structuredClone(initialBooks)));
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        config: {
            multi_account: {
                control_worldbook_name: CONTROL_BOOK,
                role_memory_key: MEMORY_ENTRY,
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
            deleteWorldbook: async name => books.delete(name),
        },
    });
    return { manager, books };
}

test('role memory is a disabled entry in SillyView_accounts, not a separate worldbook', async () => {
    const { manager, books } = createManager({
        [CONTROL_BOOK]: [{ name: 'existing_account_entry', content: '{}', enabled: false }],
    });

    await manager.ensureRoleDecisionMemoryEntry();

    assert.deepEqual([...books.keys()], [CONTROL_BOOK]);
    const entries = books.get(CONTROL_BOOK);
    const memoryEntry = entries.find(entry => entry.name === MEMORY_ENTRY);
    assert.equal(memoryEntry.enabled, false);
    assert.deepEqual(JSON.parse(memoryEntry.content), {
        version: 1,
        updated_at: 0,
        latest_run: null,
    });
});

test('legacy standalone role memory is migrated into SillyView_accounts', async () => {
    const legacyMemory = {
        version: 1,
        updated_at: 88,
        latest_run: { status: 'completed', raw_output: '旧心声' },
    };
    const { manager, books } = createManager({
        [CONTROL_BOOK]: [],
        [LEGACY_BOOK]: [{
            name: MEMORY_ENTRY,
            content: JSON.stringify(legacyMemory),
            enabled: false,
        }],
    });

    await manager.ensureRoleDecisionMemoryEntry();

    const entry = books.get(CONTROL_BOOK).find(item => item.name === MEMORY_ENTRY);
    assert.deepEqual(JSON.parse(entry.content), legacyMemory);
    assert.equal(entry.enabled, false);
    assert.equal(books.has(LEGACY_BOOK), false);
});

test('role decision memory persists the complete latest run and stays disabled', async () => {
    const { manager, books } = createManager({ [CONTROL_BOOK]: [] });
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
    const entry = books.get(CONTROL_BOOK).find(item => item.name === MEMORY_ENTRY);

    assert.deepEqual(memory.latest_run, roleRun);
    assert.equal(entry.enabled, false);
});
