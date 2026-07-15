/**
 * Loads text-t.txt and only reorders its original prompt blocks by priority.
 */
'use strict';

let cachedRules = null;

const PRIORITY_RULES = [
    { rank: 0, pattern: /SillyView\s*-\s*AI\s*指令指南|核心指令|Market\.Advance/i },
    { rank: 1, pattern: /核心世界规则与AI行为准则|最高准则|市场不为任何人服务/ },
    { rank: 2, pattern: /演绎模式|pattern_list|bull_run|bear_crash/ },
    { rank: 3, pattern: /核心市场概念|市场本质|价格波动|市场情绪/ },
    { rank: 4, pattern: /主要交易市场特性|market_profiles|股票市场|虚拟货币市场|期货\/大宗商品市场/ },
    { rank: 5, pattern: /K线图谱与形态解读|K线基础|关键K线/ },
];

function splitPromptBlocks(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = [];

    for (const line of lines) {
        const startsBlock = /^\s*(title:\s*"|#\s*SillyView\s*-)/.test(line);
        if (startsBlock && current.some(item => item.trim())) {
            blocks.push(current.join('\n').trim());
            current = [];
        }
        current.push(line);
    }

    if (current.some(item => item.trim())) {
        blocks.push(current.join('\n').trim());
    }

    return blocks;
}

function getBlockRank(block, originalIndex) {
    const matched = PRIORITY_RULES.find(rule => rule.pattern.test(block));
    return {
        rank: matched ? matched.rank : 99,
        originalIndex,
    };
}

export function sortMarketPromptText(text) {
    return splitPromptBlocks(text)
        .map((block, index) => ({ block, ...getBlockRank(block, index) }))
        .sort((a, b) => (a.rank - b.rank) || (a.originalIndex - b.originalIndex))
        .map(item => item.block)
        .join('\n\n');
}

export async function loadMarketDirectorRules() {
    if (cachedRules !== null) return cachedRules;

    try {
        const promptUrl = new URL('../../text-t.txt', import.meta.url);
        const response = await fetch(promptUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rawText = await response.text();
        cachedRules = sortMarketPromptText(rawText);
    } catch (error) {
        console.warn('[SillyView] Failed to load text-t.txt prompt rules:', error);
        cachedRules = '';
    }

    return cachedRules;
}
