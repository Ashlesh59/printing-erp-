const crypto = require('crypto');

/**
 * Authoritative Main-Process Session Manager
 * Maintains authenticated state keyed strictly by webContents ID in the Node.js main process.
 */

class SessionManager {
    constructor() {
        // Map of webContentsId (number) -> Session Object
        this.sessions = new Map();
    }

    _getSenderId(sender) {
        if (!sender) return null;
        if (typeof sender === 'number') return sender;
        if (sender.id) return sender.id;
        return null;
    }

    /**
     * Creates an authenticated session for a specific webContents sender
     * @param {Electron.WebContents} sender
     * @param {Object} user - User metadata from UserModel
     * @param {string} role - Authenticated role ('Admin', 'Manager', 'Operator')
     */
    createSession(sender, user, role) {
        const senderId = this._getSenderId(sender);
        if (!senderId) throw new Error('Invalid webContents sender for session creation');

        const session = {
            id: crypto.randomUUID(),
            webContentsId: senderId,
            role: role || (user ? user.role : 'Operator'),
            user: {
                id: user ? user.id : 0,
                name: user ? user.name : 'Authenticated User',
                role: role || (user ? user.role : 'Operator')
            },
            authenticatedAt: Date.now(),
            lastActiveAt: Date.now(),
            isKiosk: false
        };

        this.sessions.set(senderId, session);

        // Bind lifecycle listeners if sender is an EventEmitter
        if (sender && typeof sender.once === 'function') {
            sender.once('destroyed', () => {
                this.destroySession(senderId);
            });
            sender.on('did-navigate', () => {
                this.destroySession(senderId);
            });
        }

        return session;
    }

    /**
     * Establishes a restricted Customer Kiosk session
     */
    createKioskSession(sender) {
        const senderId = this._getSenderId(sender);
        if (!senderId) throw new Error('Invalid webContents sender for kiosk session');

        const session = {
            id: crypto.randomUUID(),
            webContentsId: senderId,
            role: 'Customer',
            user: { id: 0, name: 'Customer Kiosk', role: 'Customer' },
            authenticatedAt: Date.now(),
            lastActiveAt: Date.now(),
            isKiosk: true
        };

        this.sessions.set(senderId, session);
        return session;
    }

    /**
     * Retrieves the active session for a sender
     */
    getSession(sender) {
        const senderId = this._getSenderId(sender);
        if (!senderId) return null;
        const session = this.sessions.get(senderId);
        if (!session) return null;

        session.lastActiveAt = Date.now();
        return session;
    }

    /**
     * Destroys an active session for a sender
     */
    destroySession(sender) {
        const senderId = this._getSenderId(sender);
        if (!senderId) return false;
        return this.sessions.delete(senderId);
    }

    /**
     * Checks if the sender has one of the allowed roles
     * @param {Electron.WebContents} sender
     * @param {string[]} allowedRoles
     * @returns {{ authorized: boolean, error?: string, session?: Object }}
     */
    requireRole(sender, allowedRoles = []) {
        const session = this.getSession(sender);
        if (!session) {
            return {
                authorized: false,
                code: 'UNAUTHORIZED',
                error: 'Authentication Required: No active session for this terminal.'
            };
        }

        if (allowedRoles.length === 0) {
            return { authorized: true, session };
        }

        if (!allowedRoles.includes(session.role)) {
            return {
                authorized: false,
                code: 'FORBIDDEN',
                error: `Access Denied: Role '${session.role}' is not authorized for this operation. Required: [${allowedRoles.join(', ')}]`,
                session
            };
        }

        return { authorized: true, session };
    }

    /**
     * Clears all sessions (e.g. for testing)
     */
    resetAll() {
        this.sessions.clear();
    }
}

module.exports = new SessionManager();
