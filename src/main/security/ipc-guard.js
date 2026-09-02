const { ipcMain } = require('electron');
const sessionManager = require('./session-manager');

/**
 * Centralized IPC Authorization Layer & Permission Matrix
 */

const ROLES = {
    PUBLIC: 'PUBLIC',
    CUSTOMER: ['Customer', 'Operator', 'Manager', 'Admin'],
    OPERATOR: ['Operator', 'Manager', 'Admin'],
    MANAGER: ['Manager', 'Admin'],
    ADMIN: ['Admin']
};

/**
 * Creates a guarded wrapper function for an IPC handler
 * @param {string} channel - IPC channel name
 * @param {string[]|string} allowedRoles - Required role or array of allowed roles
 * @param {Function} handler - The implementation function (event, ...args)
 */
function createGuardedWrapper(channel, allowedRoles, handler) {
    return async (event, ...args) => {
        // 1. If public, execute directly without role checks
        if (allowedRoles === ROLES.PUBLIC || allowedRoles === 'PUBLIC') {
            try {
                return await handler(event, ...args);
            } catch (err) {
                console.error(`[IPC Error] Channel ${channel}:`, err.message);
                return { success: false, error: err.message };
            }
        }

        // 2. Validate sender webContents & role
        const targetRoles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
        const auth = sessionManager.requireRole(event ? event.sender : null, targetRoles);

        if (!auth.authorized) {
            console.warn(`[Security Alert] Unauthorized IPC attempt on '${channel}' from webContents ID ${event && event.sender ? event.sender.id : 'unknown'}: ${auth.error}`);
            return {
                success: false,
                error: auth.error || 'Access Denied: Unauthorized request',
                code: auth.code || 'FORBIDDEN'
            };
        }

        // 3. Authorized — execute handler
        try {
            return await handler(event, ...args);
        } catch (err) {
            console.error(`[IPC Error] Channel ${channel}:`, err.message);
            return { success: false, error: err.message };
        }
    };
}

/**
 * Registers an IPC handler with strict main-process role verification
 * @param {string} channel - IPC channel name
 * @param {string[]|string} allowedRoles - Required role or array of allowed roles
 * @param {Function} handler - The implementation function (event, ...args)
 */
function registerGuardedHandler(channel, allowedRoles, handler) {
    const wrapped = createGuardedWrapper(channel, allowedRoles, handler);
    ipcMain.handle(channel, wrapped);
    return wrapped;
}

module.exports = {
    ROLES,
    createGuardedWrapper,
    registerGuardedHandler
};
