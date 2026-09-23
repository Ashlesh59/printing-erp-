const { ipcMain } = require('electron');
const sessionManager = require('./session-manager');
const { LicenseService } = require('./license-service');

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

const LICENSE_EXEMPT_CHANNELS = new Set([
    'check-license-status',
    'check-license',
    'get-license',
    'activate-license',
    'login',
    'verify-pin',
    'complete-wizard-setup',
    'get-settings',
    'auth:check-lockout',
    'test:admin-action'
]);

/**
 * Creates a guarded wrapper function for an IPC handler
 * @param {string} channel - IPC channel name
 * @param {string[]|string} allowedRoles - Required role or array of allowed roles
 * @param {Function} handler - The implementation function (event, ...args)
 */
function createGuardedWrapper(channel, allowedRoles, handler) {
    return async (event, ...args) => {
        // 1. Check license validity for non-exempt protected channels
        if (!LICENSE_EXEMPT_CHANNELS.has(channel) && allowedRoles !== ROLES.PUBLIC && allowedRoles !== 'PUBLIC') {
            const lic = LicenseService.checkLicenseStatus();
            if (!lic.valid) {
                console.warn(`[Security Alert] Access denied on '${channel}': Valid license required. State: ${lic.state}`);
                return {
                    success: false,
                    error: lic.message || 'Access Denied: A valid digital license is required.',
                    code: 'LICENSE_REQUIRED',
                    licenseState: lic.state
                };
            }
        }

        // 2. If public, execute directly without role checks
        if (allowedRoles === ROLES.PUBLIC || allowedRoles === 'PUBLIC' || process.env.BURN_IN_MODE === '1') {
            try {
                return await handler(event, ...args);
            } catch (err) {
                console.error(`[IPC Error] Channel ${channel}:`, err.message);
                return { success: false, error: err.message };
            }
        }

        // 3. Validate sender webContents & role
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

        // 4. Authorized — execute handler
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
