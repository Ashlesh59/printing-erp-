/**
 * Authentication Brute-Force & Lockout Throttler
 * Applies progressive delays and temporary lockout to mitigate automated PIN guessing.
 */

class AuthThrottle {
    constructor(options = {}) {
        this.tier1Threshold = options.tier1Threshold || 5;    // 5 fails -> 30s lockout
        this.tier1DurationMs = options.tier1DurationMs || 30 * 1000;
        this.tier2Threshold = options.tier2Threshold || 10;   // 10 fails -> 300s (5m) lockout
        this.tier2DurationMs = options.tier2DurationMs || 300 * 1000;
        this.timeProvider = typeof options.timeProvider === 'function' ? options.timeProvider : () => Date.now();
        
        // Map of key (e.g. "role:ip" or "role:senderId") -> { failures: number, lockedUntil: number, lastFailure: number }
        this.records = new Map();
    }

    _now() {
        return this.timeProvider();
    }

    _makeKey(senderId, role = 'General') {
        return `${String(role).toUpperCase()}:${senderId || 'default'}`;
    }

    /**
     * Checks if authentication is currently locked out for the given sender & role
     * @returns {{ locked: boolean, remainingSeconds: number }}
     */
    isLocked(senderId, role = 'General') {
        const key = this._makeKey(senderId, role);
        const record = this.records.get(key);
        if (!record) return { locked: false, remainingSeconds: 0 };

        const now = this._now();
        if (record.lockedUntil && record.lockedUntil > now) {
            const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
            return { locked: true, remainingSeconds };
        }

        // Lockout has expired; reset lockedUntil
        if (record.lockedUntil && record.lockedUntil <= now) {
            record.lockedUntil = 0;
        }

        return { locked: false, remainingSeconds: 0 };
    }

    /**
     * Records a failed authentication attempt and calculates lockout / progressive delay
     * @returns {{ locked: boolean, remainingSeconds: number, attempts: number }}
     */
    recordFailure(senderId, role = 'General') {
        const key = this._makeKey(senderId, role);
        const now = this._now();
        let record = this.records.get(key);

        if (!record) {
            record = { failures: 0, lockedUntil: 0, lastFailure: now };
            this.records.set(key, record);
        }

        record.failures += 1;
        record.lastFailure = now;

        if (record.failures >= this.tier2Threshold) {
            record.lockedUntil = now + this.tier2DurationMs;
        } else if (record.failures >= this.tier1Threshold) {
            record.lockedUntil = now + this.tier1DurationMs;
        }

        const isLocked = record.lockedUntil > now;
        const remainingSeconds = isLocked ? Math.ceil((record.lockedUntil - now) / 1000) : 0;

        return {
            locked: isLocked,
            remainingSeconds,
            attempts: record.failures
        };
    }

    /**
     * Resets failure counter upon successful authentication
     */
    recordSuccess(senderId, role = 'General') {
        const key = this._makeKey(senderId, role);
        this.records.delete(key);
    }

    /**
     * Cleans up expired records
     */
    cleanup() {
        const now = this._now();
        for (const [key, record] of this.records.entries()) {
            if (record.lockedUntil <= now && (now - record.lastFailure) > 3600 * 1000) {
                this.records.delete(key);
            }
        }
    }

    /**
     * Inject custom time provider (e.g. fake clock for testing)
     */
    setTimeProvider(fn) {
        this.timeProvider = typeof fn === 'function' ? fn : () => Date.now();
    }

    /**
     * Reset time provider to default Date.now
     */
    resetTimeProvider() {
        this.timeProvider = () => Date.now();
    }

    /**
     * Reset all records (for testing purposes)
     */
    resetAll() {
        this.records.clear();
    }
}

const singleton = new AuthThrottle();
singleton.AuthThrottle = AuthThrottle;

module.exports = singleton;
