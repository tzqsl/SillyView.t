import test from 'node:test';
import assert from 'node:assert/strict';

import { RoleDecisionService } from '../modules/services/roleDecisionService.js';

test('role system prompt lists imported tag names as roleplay assignments', () => {
    const service = Object.create(RoleDecisionService.prototype);
    const prompt = service._buildRoleSystemPrompt('COMMAND GUIDE', 'OUTPUT RULES', [
        { content: '<张三>\n谨慎而多疑。\n</张三>' },
        { role_name: '李四', content: '<李四>\n冲动但重视朋友。\n</李四>' },
        { content: '<张三>\n重复资料。\n</张三>' },
    ]);

    assert.match(prompt, /以下全部人物都属于你的扮演任务/);
    assert.match(prompt, /1\. 张三（来源标签 <张三><\/张三>）/);
    assert.match(prompt, /2\. 李四（来源标签 <李四><\/李四>）/);
    assert.equal((prompt.match(/来源标签 <张三><\/张三>/g) || []).length, 1);
    assert.match(prompt, /第一人称“我”表达/);
    assert.match(prompt, /禁止用第三人称旁观视角/);
    assert.match(prompt, /并不默认指角色对 FX、行情或交易的看法/);
    assert.match(prompt, /若本轮正文与 FX 无关/);
});

test('role system prompt does not invent an index when no profiles were imported', () => {
    const service = Object.create(RoleDecisionService.prototype);
    const prompt = service._buildRoleSystemPrompt('COMMAND GUIDE', 'OUTPUT RULES', []);

    assert.match(prompt, /未导入角色；不得自行创造需要扮演的人物/);
});

test('repeated observation is deferred and merged into the next user turn', async () => {
    const observeCommand = { module: 'Observe', type: 'Market', args: [] };
    const service = Object.create(RoleDecisionService.prototype);
    let marketVersion = 0;
    let generationCalls = [];
    let outputs = [
        '<command>[Observe.Market()]</command>',
        '<command>[Observe.Market()]</command>',
    ];
    Object.assign(service, {
        running: false,
        pendingObservationCommands: null,
        lastRun: null,
        commandParser: {
            parse: text => String(text).includes('Observe.Market') ? [observeCommand] : [],
        },
        data: {
            beginManagedObservationSession: async () => {
                marketVersion += 1;
                return {
                    active: true,
                    id: 'session-' + marketVersion,
                    context: 'MARKET-' + marketVersion,
                    account_ids: [],
                    market_requested: true,
                    activated_entries: [],
                };
            },
            endManagedObservationSession: async () => true,
        },
        _loadPromptGuides: async () => ({ command_guide: '', output_rules: '' }),
        _loadRoleProfiles: async () => [],
        _buildRoleSystemPrompt: () => 'SYSTEM',
        _generate: async prompts => {
            generationCalls.push(prompts);
            return outputs.shift() || 'FINAL';
        },
        _executeTradeCommands: async () => [],
        _buildFrontendInjection: output => output,
    });

    const first = await service.run({ previous_content: 'PREVIOUS-1', user_content: 'USER-1' });
    assert.equal(generationCalls.length, 2);
    assert.equal(marketVersion, 1);
    assert.equal(first.observation_rounds.filter(round => round.active).length, 1);
    assert.equal(first.observation_rounds.at(-1).deferred_to_next_turn, true);
    assert.deepEqual(service.pendingObservationCommands, [observeCommand]);

    generationCalls = [];
    outputs = ['FINAL'];
    const second = await service.run({ previous_content: 'PREVIOUS-2', user_content: 'USER-2' });
    assert.equal(generationCalls.length, 1);
    assert.equal(marketVersion, 2);
    const mergedPrompt = generationCalls[0].map(item => item.content).join('\n');
    assert.match(mergedPrompt, /USER-2/);
    assert.match(mergedPrompt, /MARKET-2/);
    assert.equal(second.observation_rounds[0].deferred_from_previous_turn, true);
    assert.equal(service.pendingObservationCommands, null);
});
