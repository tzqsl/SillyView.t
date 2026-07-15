/**
 * SillyView - Command Parser (Functional Syntax)
 * Parses text for standardized game commands from the AI using a functional syntax.
 */
'use strict';
import { Logger } from '../logger.js';

export class CommandParser {
    /**
     * Extracts all valid functional commands from a block of text.
     * @param {string} text The text content from the AI's message.
     * @returns {Array<object>} An array of parsed command objects.
     */
    parse(text) {
        if (!text || typeof text !== 'string') return [];
        
        const commandBlockRegex = /<command>([\s\S]*?)<\/command>/g;
        let commandContent = '';
        let match;

        while ((match = commandBlockRegex.exec(text)) !== null) {
            commandContent += match[1].trim();
        }

        if (!commandContent) {
            return [];
        }

        const commands = [];
        let openBrackets = 0;
        let commandStart = -1;

        for (let i = 0; i < commandContent.length; i++) {
            if (commandContent[i] === '[') {
                if (openBrackets === 0) commandStart = i;
                openBrackets++;
            } else if (commandContent[i] === ']') {
                openBrackets--;
                if (openBrackets === 0 && commandStart !== -1) {
                    const commandString = commandContent.substring(commandStart + 1, i);
                    const parsed = this._parseFunctionCall(commandString);
                    if (parsed) commands.push(parsed);
                    commandStart = -1;
                }
            }
        }
        
        return commands;
    }
    
    /**
     * Parses a single function call string, e.g., "Market.Advance(285.50, "bull_run")".
     * @param {string} callString The content inside the brackets `[]`.
     * @returns {object|null} A parsed command object or null if parsing fails.
     */
    _parseFunctionCall(callString) {
        if (!callString) return null;

        const match = callString.trim().match(/^(\w+)\.(\w+)\(([\s\S]*)\)$/);

        if (!match) {
            Logger.warn(`无效的函数调用格式: "${callString}"`);
            return null;
        }

        const [, module, type, argsString] = match;
        let args = [];

        if (argsString.trim()) {
            const argParts = this._splitArgs(argsString);
            args = argParts.map(part => {
                // Check if it's a quoted string
                if (part.startsWith('"') && part.endsWith('"')) {
                    return part.slice(1, -1).replace(/\\"/g, '"');
                }
                // Otherwise, try to parse as a number
                const num = parseFloat(part);
                return isNaN(num) ? part : num;
            });
        }
        
        const command = { module, type, args };
        Logger.success(`成功解析指令: ${command.module}.${command.type}`);
        return command;
    }

    _splitArgs(argsString) {
        const args = [];
        let current = '';
        let inString = false;
        let escaped = false;

        for (const char of argsString) {
            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }

            if (char === '\\' && inString) {
                current += char;
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                current += char;
                continue;
            }

            if (char === ',' && !inString) {
                args.push(current.trim());
                current = '';
                continue;
            }

            current += char;
        }

        if (current.trim()) args.push(current.trim());
        return args;
    }
};
