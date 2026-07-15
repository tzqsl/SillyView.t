/**
 * SillyView - Logger Module
 * 
 * A simple utility for logging formatted messages to the console.
 * This helps in debugging and tracking the application's flow.
 */
'use strict';

import { SillyViewConfig } from './config.js';

export const Logger = {
    prefix: `[${SillyViewConfig.extension_name}]`,
    
    log(message, ...args) {
        console.log(`${this.prefix} ${message}`, ...args);
    },

    warn(message, ...args) {
        console.warn(`${this.prefix} ${message}`, ...args);
    },

    error(message, ...args) {
        console.error(`${this.prefix} ${message}`, ...args);
    },

    /**
     * Logs a success message in green.
     * @param {string} message - The message to log.
     * @param {...any} args - Additional arguments to log.
     */
    success(message, ...args) {
        console.log(`%c${this.prefix} ${message}`, 'color: #22c55e;', ...args);
    }
};
