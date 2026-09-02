const crypto = require('crypto');
const db = require('../database/db');

const LicenseState = {
    UNACTIVATED: 'UNACTIVATED',
    VALID: 'VALID',
    EXPIRED: 'EXPIRED',
    INVALID: 'INVALID',
    VERIFICATION_ERROR: 'VERIFICATION_ERROR'
};

class LicenseService {
    constructor() {
        // Internal HMAC signing seed for offline format validation
        this._offlineSecret = 'PSM_OFFLINE_VALIDATION_SALT_V1';
    }

    _isPackaged() {
        try {
            const { app } = require('electron');
            return app && app.isPackaged === true;
        } catch(e) {
            return false;
        }
    }

    _isDevValidatorAllowed() {
        // Packaged builds can NEVER use development validator
        if (this._isPackaged()) return false;
        return process.env.NODE_ENV === 'development' && process.env.PSM_DEV_LICENSE === 'true';
    }

    /**
     * Verifies license format and integrity
     * Format: PSM-<TIER>-<EXPIRY_YYYYMMDD>-<PAYLOAD>-<CHECKSUM>
     * e.g. PSM-PRO-20281231-A8B9-3D4F
     */
    _verifyKeyStructure(cleanKey) {
        if (!cleanKey || typeof cleanKey !== 'string') {
            return { valid: false, state: LicenseState.INVALID, message: 'License key is missing or empty' };
        }

        const upper = cleanKey.trim().toUpperCase();

        // 1. Dev Key Handling (Only allowed when dev environment is explicitly enabled and NOT packaged)
        if (upper.startsWith('PSM-DEV-')) {
            if (this._isDevValidatorAllowed()) {
                return {
                    valid: true,
                    state: LicenseState.VALID,
                    tier: 'Development',
                    expiresAt: '2099-12-31',
                    message: 'Development license active (Dev Environment Only)'
                };
            } else {
                return {
                    valid: false,
                    state: LicenseState.INVALID,
                    message: 'Development license keys are not permitted in production builds.'
                };
            }
        }

        // 2. Structured Commercial Key Format: PSM-<TIER>-<EXPIRY_YYYYMMDD>-<PAYLOAD>-<CHECKSUM>
        const match = upper.match(/^PSM-([A-Z]{3,4})-(\d{8})-([A-Z0-9]{4})-([A-Z0-9]{4})$/);
        if (!match) {
            return {
                valid: false,
                state: LicenseState.INVALID,
                message: 'Invalid license format. Expected format: PSM-XXXX-YYYYMMDD-XXXX-XXXX'
            };
        }

        const [, tier, expiryStr, payload, checksum] = match;

        // Check expiration date
        const year = parseInt(expiryStr.substring(0, 4), 10);
        const month = parseInt(expiryStr.substring(4, 6), 10) - 1;
        const day = parseInt(expiryStr.substring(6, 8), 10);
        const expiryDate = new Date(Date.UTC(year, month, day, 23, 59, 59));

        if (isNaN(expiryDate.getTime())) {
            return { valid: false, state: LicenseState.INVALID, message: 'Invalid expiration date in license key' };
        }

        const now = new Date();
        if (expiryDate < now) {
            return {
                valid: false,
                state: LicenseState.EXPIRED,
                expiresAt: expiryDate.toISOString().split('T')[0],
                message: 'This license key expired on ' + expiryDate.toISOString().split('T')[0]
            };
        }

        // Verify checksum: first 4 hex chars of SHA-256 over tier + expiry + payload + salt
        const rawToHash = `${tier}-${expiryStr}-${payload}-${this._offlineSecret}`;
        const computedChecksum = crypto.createHash('sha256').update(rawToHash).digest('hex').substring(0, 4).toUpperCase();

        if (checksum !== computedChecksum) {
            return {
                valid: false,
                state: LicenseState.INVALID,
                message: 'License key integrity verification failed'
            };
        }

        return {
            valid: true,
            state: LicenseState.VALID,
            tier,
            expiresAt: expiryDate.toISOString().split('T')[0],
            message: 'Commercial license verified successfully'
        };
    }

    /**
     * Checks current license status from database (Fail-Closed)
     * @returns {{ valid: boolean, state: string, message: string, info?: Object }}
     */
    checkLicenseStatus() {
        try {
            const row = db.prepare('SELECT * FROM license WHERE id = 1').get();
            if (!row || !row.license_key || row.license_key.trim() === '') {
                return {
                    valid: false,
                    state: LicenseState.UNACTIVATED,
                    message: 'Software is not activated. Please enter a valid license key.'
                };
            }

            const verification = this._verifyKeyStructure(row.license_key);
            if (!verification.valid) {
                return {
                    valid: false,
                    state: verification.state,
                    message: verification.message
                };
            }

            return {
                valid: true,
                state: LicenseState.VALID,
                message: 'License is active and valid.',
                info: {
                    tier: verification.tier,
                    expiresAt: verification.expiresAt,
                    activatedOn: row.activated_on
                }
            };
        } catch (err) {
            console.error('[LicenseService] Database verification error:', err);
            // Fail-closed
            return {
                valid: false,
                state: LicenseState.VERIFICATION_ERROR,
                message: 'An error occurred while verifying the license. Access denied.'
            };
        }
    }

    /**
     * Activates a new license key (Fail-Closed)
     * @param {string} rawKey
     * @returns {{ success: boolean, state: string, message: string }}
     */
    activateLicense(rawKey) {
        if (!rawKey || typeof rawKey !== 'string') {
            return {
                success: false,
                state: LicenseState.INVALID,
                message: 'License key is required.'
            };
        }

        const cleanKey = rawKey.trim().toUpperCase();
        const verification = this._verifyKeyStructure(cleanKey);

        if (!verification.valid) {
            return {
                success: false,
                state: verification.state,
                message: verification.message
            };
        }

        try {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO license (id, license_key, activated_on, expires_at, license_type, status)
                VALUES (1, ?, CURRENT_TIMESTAMP, ?, ?, ?)
            `);
            stmt.run(cleanKey, verification.expiresAt, verification.tier, LicenseState.VALID);

            return {
                success: true,
                state: LicenseState.VALID,
                message: 'License activated successfully!'
            };
        } catch (err) {
            console.error('[LicenseService] Activation DB error:', err);
            return {
                success: false,
                state: LicenseState.VERIFICATION_ERROR,
                message: 'Database error during activation.'
            };
        }
    }

    /**
     * Returns sanitized public license info for display
     */
    getPublicLicenseInfo() {
        try {
            const row = db.prepare('SELECT * FROM license WHERE id = 1').get();
            if (!row || !row.license_key) {
                return {
                    state: LicenseState.UNACTIVATED,
                    license_key: 'Unactivated',
                    activated_on: null,
                    expires_at: null
                };
            }

            const raw = row.license_key;
            // Mask key: PSM-XXXX-****-****-XXXX
            let masked = raw;
            if (raw.length > 8) {
                const start = raw.substring(0, 8);
                const end = raw.substring(raw.length - 4);
                masked = `${start}-****-${end}`;
            }

            return {
                state: row.status || LicenseState.VALID,
                license_key: masked,
                activated_on: row.activated_on,
                expires_at: row.expires_at,
                license_type: row.license_type
            };
        } catch (e) {
            return {
                state: LicenseState.VERIFICATION_ERROR,
                license_key: 'Error loading license',
                activated_on: null
            };
        }
    }

    /**
     * Helper to generate valid signed keys (for commercial license generation / testing)
     */
    generateSignedKey(tier = 'PRO', expiryYmd = '20281231', payload = 'A1B2') {
        const rawToHash = `${tier}-${expiryYmd}-${payload}-${this._offlineSecret}`;
        const checksum = crypto.createHash('sha256').update(rawToHash).digest('hex').substring(0, 4).toUpperCase();
        return `PSM-${tier}-${expiryYmd}-${payload}-${checksum}`;
    }

    /**
     * Public verification helper
     */
    verifyLicenseKey(cleanKey) {
        return this._verifyKeyStructure(cleanKey);
    }
}

module.exports = {
    LicenseState,
    LicenseService: new LicenseService()
};
