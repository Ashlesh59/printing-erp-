const crypto = require('crypto');
const db = require('../database/db');

const LicenseState = {
    UNACTIVATED: 'UNACTIVATED',
    VALID: 'VALID',
    EXPIRED: 'EXPIRED',
    INVALID: 'INVALID',
    VERIFICATION_ERROR: 'VERIFICATION_ERROR',
    CLOCK_ROLLBACK: 'CLOCK_ROLLBACK'
};

// Default Production Public Verification Key (SPKI PEM Format)
// The corresponding private key is held strictly by the offline licensing authority and NEVER committed.
const DEFAULT_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALgE4Z6c0oY9gM2VqJj8f4k7wN1rB5xX3mQ8yL2pT1vA=
-----END PUBLIC KEY-----`;

// Offline Development & Local Verification Public Key (SPKI PEM Format)
const DEV_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA/RHF6wSqZFdL1/gk5ujSSDlvRh6ntkkGsiQwpd80tpg=
-----END PUBLIC KEY-----`;

class LicenseService {
    constructor() {
        this.publicKey = DEFAULT_PRODUCTION_PUBLIC_KEY;
        this.timeProvider = () => Date.now();
    }

    /**
     * Injects custom verification public key (used in isolated test fixtures only)
     * @param {string|crypto.KeyObject} key 
     */
    setVerificationPublicKey(key) {
        if (this._isPackaged()) {
            throw new Error('Security Violation: Verification key replacement is strictly blocked in packaged production builds.');
        }
        this.publicKey = key;
    }

    /**
     * Injects custom time provider for testing
     * @param {Function} provider 
     */
    setTimeProvider(provider) {
        this.timeProvider = typeof provider === 'function' ? provider : () => Date.now();
    }

    _now() {
        return this.timeProvider();
    }

    _isPackaged() {
        try {
            const { app } = require('electron');
            return app && app.isPackaged === true;
        } catch(e) {
            return false;
        }
    }

    /**
     * Verifies an asymmetric Ed25519 digital license token
     * Format: PSM-ED25519.<BASE64_PAYLOAD>.<BASE64_SIGNATURE> or PSM.<BASE64_PAYLOAD>.<BASE64_SIGNATURE>
     * @param {string} rawKey 
     * @returns {{ valid: boolean, state: string, message: string, payload?: Object }}
     */
    verifyLicenseKey(rawKey) {
        if (!rawKey || typeof rawKey !== 'string') {
            return { valid: false, state: LicenseState.INVALID, message: 'License key is missing or empty' };
        }

        const trimmed = rawKey.trim();
        const parts = trimmed.split('.');
        if (parts.length !== 3 || (!parts[0].startsWith('PSM-ED25519') && parts[0] !== 'PSM')) {
            return {
                valid: false,
                state: LicenseState.INVALID,
                message: 'Invalid digital license format. Expected Ed25519 signed license token.'
            };
        }

        const [, b64Payload, b64Signature] = parts;

        let payloadBuf, sigBuf, payload;
        try {
            payloadBuf = Buffer.from(b64Payload, 'base64');
            sigBuf = Buffer.from(b64Signature, 'base64');
            payload = JSON.parse(payloadBuf.toString('utf8'));
        } catch (e) {
            return {
                valid: false,
                state: LicenseState.INVALID,
                message: 'Malformed license payload or signature encoding.'
            };
        }

        // Verify cryptographic Ed25519 signature
        try {
            let isSignatureValid = crypto.verify(null, payloadBuf, this.publicKey, sigBuf);
            if (!isSignatureValid && !this._isPackaged()) {
                try {
                    isSignatureValid = crypto.verify(null, payloadBuf, DEV_PUBLIC_KEY, sigBuf);
                } catch(e) {}
            }
            if (!isSignatureValid) {
                return {
                    valid: false,
                    state: LicenseState.INVALID,
                    message: 'Cryptographic digital signature verification failed. Untrusted or tampered license.'
                };
            }
        } catch (verifyErr) {
            return {
                valid: false,
                state: LicenseState.VERIFICATION_ERROR,
                message: `License signature verification error: ${verifyErr.message}`
            };
        }

        // Validate and normalize payload fields
        if (!payload || typeof payload !== 'object') {
            return { valid: false, state: LicenseState.INVALID, message: 'Invalid payload structure.' };
        }

        if (payload.product !== 'PrintShopManager') {
            return { valid: false, state: LicenseState.INVALID, message: 'License is not designated for PrintShopManager.' };
        }

        const normalized = {
            product: payload.product,
            tier: String(payload.tier || 'PRO').toUpperCase(),
            licenseId: payload.license_id || payload.licenseId,
            shopId: payload.shop_id || payload.shopId,
            shopName: payload.shop_name || payload.shopName || 'Authorized Print Shop',
            expiresAt: payload.expires_at || payload.expiresAt,
            issuedAt: payload.issued_at || payload.issuedAt,
            maxDevices: payload.max_devices !== undefined ? payload.max_devices : (payload.maxDevices !== undefined ? payload.maxDevices : 5),
            features: payload.features || []
        };

        if (!normalized.licenseId || typeof normalized.licenseId !== 'string') {
            return { valid: false, state: LicenseState.INVALID, message: 'Missing license ID in payload.' };
        }

        const allowedTiers = ['STARTER', 'PRO', 'ENTERPRISE', 'COMMERCIAL', 'COMMUNITY'];
        if (!allowedTiers.includes(normalized.tier)) {
            return { valid: false, state: LicenseState.INVALID, message: `Unknown license tier: ${payload.tier}` };
        }

        // Validate dates
        if (!normalized.expiresAt) {
            return { valid: false, state: LicenseState.INVALID, message: 'Missing license expiration date.' };
        }

        const expiryDate = new Date(normalized.expiresAt);
        if (isNaN(expiryDate.getTime())) {
            return { valid: false, state: LicenseState.INVALID, message: 'Invalid expiration date format.' };
        }

        const now = new Date(this._now());
        if (expiryDate < now) {
            return {
                valid: false,
                state: LicenseState.EXPIRED,
                expiresAt: expiryDate.toISOString().split('T')[0],
                message: `License expired on ${expiryDate.toISOString().split('T')[0]}.`
            };
        }

        if (normalized.issuedAt) {
            const issuedDate = new Date(normalized.issuedAt);
            if (!isNaN(issuedDate.getTime()) && issuedDate.getTime() > (this._now() + 86400000)) {
                return {
                    valid: false,
                    state: LicenseState.CLOCK_ROLLBACK,
                    message: 'System clock error: License issue date is in the future.'
                };
            }
        }

        return {
            valid: true,
            state: LicenseState.VALID,
            tier: normalized.tier,
            licenseId: normalized.licenseId,
            shopName: normalized.shopName,
            expiresAt: expiryDate.toISOString().split('T')[0],
            issuedAt: normalized.issuedAt || null,
            maxDevices: normalized.maxDevices,
            message: 'Digital Ed25519 license verified successfully.',
            payload
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
                    message: 'Software is not activated. Please enter a valid digital license key.'
                };
            }

            const verification = this.verifyLicenseKey(row.license_key);
            if (!verification.valid) {
                return {
                    valid: false,
                    state: verification.state,
                    message: verification.message
                };
            }

            // Anti-clock rollback verification against stored DB timestamps
            if (row.activated_on) {
                const actDate = new Date(row.activated_on);
                if (!isNaN(actDate.getTime()) && actDate.getTime() > (this._now() + 86400000)) {
                    return {
                        valid: false,
                        state: LicenseState.CLOCK_ROLLBACK,
                        message: 'System clock has been manipulated backwards past activation date.'
                    };
                }
            }

            return {
                valid: true,
                state: LicenseState.VALID,
                message: 'License is active and cryptographically verified.',
                info: {
                    licenseId: verification.licenseId,
                    tier: verification.tier,
                    shopName: verification.shopName,
                    expiresAt: verification.expiresAt,
                    activatedOn: row.activated_on
                }
            };
        } catch (err) {
            console.error('[LicenseService] Database license check error:', err);
            // Fail-closed
            return {
                valid: false,
                state: LicenseState.VERIFICATION_ERROR,
                message: 'A database error occurred while verifying the digital license. Access denied.'
            };
        }
    }

    /**
     * Activates a new digital license key (Fail-Closed)
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

        const cleanKey = rawKey.trim();
        const verification = this.verifyLicenseKey(cleanKey);

        if (!verification.valid) {
            return {
                success: false,
                state: verification.state,
                message: verification.message
            };
        }

        try {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO license (id, license_key, activated_on, expires_at, license_type, status, meta_json)
                VALUES (1, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
            `);
            stmt.run(
                cleanKey,
                verification.expiresAt,
                verification.tier,
                LicenseState.VALID,
                JSON.stringify(verification.payload || {})
            );

            return {
                success: true,
                state: LicenseState.VALID,
                message: 'Digital license activated and verified successfully!'
            };
        } catch (err) {
            console.error('[LicenseService] Activation DB error:', err);
            return {
                success: false,
                state: LicenseState.VERIFICATION_ERROR,
                message: 'Database error during license activation.'
            };
        }
    }

    /**
     * Returns public license summary for UI display
     */
    getPublicLicenseInfo() {
        try {
            const row = db.prepare('SELECT * FROM license WHERE id = 1').get();
            if (!row || !row.license_key) {
                return {
                    state: LicenseState.UNACTIVATED,
                    license_key: 'Unactivated',
                    activated_on: null,
                    expires_at: null,
                    license_type: null
                };
            }

            const raw = row.license_key;
            // Masked display: PSM-ED25519.XXXX...XXXX
            const parts = raw.split('.');
            let masked = raw;
            if (parts.length === 3) {
                const head = parts[1].substring(0, 6);
                const tail = parts[2].substring(parts[2].length - 6);
                masked = `${parts[0]}.${head}****.${tail}`;
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
}

const singleton = new LicenseService();
singleton.LicenseState = LicenseState;
singleton.LicenseService = LicenseService;

module.exports = {
    LicenseState,
    LicenseService: singleton
};
