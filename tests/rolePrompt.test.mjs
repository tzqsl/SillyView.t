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
