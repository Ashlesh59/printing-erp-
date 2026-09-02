const crypto = require('crypto');

/**
 * Secure PIN Cryptography & Complexity Enforcement
 * Uses Node's built-in crypto.scrypt (salted, slow key derivation)
 * Storage Format: scrypt$v=1$N=16384,r=8,p=1$<salt_hex>$<hash_hex>
 */

const SCRYPT_PARAMS = {
    N: 16384,
    r: 8,
    p: 1,
    keylen: 32,
    maxmem: 32 * 1024 * 1024
};

const KNOWN_DEFAULT_PINS = new Set([
    '1234', '5678', '0000', '1111', '2222', '3333', '4444', '5555',
    '6666', '7777', '8888', '9999', '123456', '654321', '000000',
    '111111', '222222', '333333', '444444', '555555', '666666',
    '777777', '888888', '999999', '121212', '112233', '123123'
]);

/**
 * Validates PIN complexity rules
 * - Must be digits only
 * - Must be at least 6 digits and at most 12 digits
 * - Cannot be a known common default PIN
 * - Cannot be all identical repeating digits (e.g. 111111)
 * - Cannot be sequential ascending (e.g. 123456) or descending (e.g. 654321)
 */
function validatePinComplexity(pin) {
    if (!pin || typeof pin !== 'string') {
        return { valid: false, error: 'PIN must be a non-empty string of digits' };
    }

    const cleanPin = pin.trim();

    if (!/^\d{6,12}$/.test(cleanPin)) {
        return { valid: false, error: 'PIN must be between 6 and 12 numeric digits' };
    }

    if (KNOWN_DEFAULT_PINS.has(cleanPin)) {
        return { valid: false, error: 'This PIN is too common or matches a default value. Please choose a more secure PIN.' };
    }

    // Check all identical digits (e.g. 777777)
    if (/^(\d)\1+$/.test(cleanPin)) {
        return { valid: false, error: 'PIN cannot consist of repeating identical digits.' };
    }

    // Check sequential ascending (e.g. 012345, 123456, 456789)
    let isAscending = true;
    let isDescending = true;
    for (let i = 1; i < cleanPin.length; i++) {
        const prev = parseInt(cleanPin[i - 1], 10);
        const curr = parseInt(cleanPin[i], 10);
        if (curr !== (prev + 1) % 10) isAscending = false;
        if (curr !== (prev - 1 + 10) % 10) isDescending = false;
    }

    if (isAscending) {
        return { valid: false, error: 'PIN cannot be a sequential ascending series (e.g. 123456).' };
    }
    if (isDescending) {
        return { valid: false, error: 'PIN cannot be a sequential descending series (e.g. 654321).' };
    }

    return { valid: true };
}

/**
 * Checks if a PIN is in the known default list
 */
function isKnownDefaultPin(pin) {
    if (!pin) return true;
    const str = String(pin).trim();
    return KNOWN_DEFAULT_PINS.has(str);
}

/**
 * Generates salted scrypt hash for a PIN
 * @param {string} pin - Raw numeric PIN
 * @returns {Promise<string>} Formatted hash string
 */
function hashPin(pin) {
    return new Promise((resolve, reject) => {
        if (!pin || typeof pin !== 'string') {
            return reject(new Error('Invalid PIN for hashing'));
        }
        const salt = crypto.randomBytes(16);
        crypto.scrypt(pin, salt, SCRYPT_PARAMS.keylen, {
            N: SCRYPT_PARAMS.N,
            r: SCRYPT_PARAMS.r,
            p: SCRYPT_PARAMS.p,
            maxmem: SCRYPT_PARAMS.maxmem
        }, (err, derivedKey) => {
            if (err) return reject(err);
            const saltHex = salt.toString('hex');
            const hashHex = derivedKey.toString('hex');
            const formatted = `scrypt$v=1$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${saltHex}$${hashHex}`;
            resolve(formatted);
        });
    });
}

/**
 * Synchronous hash helper for migrations / synchronous initialization
 */
function hashPinSync(pin) {
    if (!pin || typeof pin !== 'string') {
        throw new Error('Invalid PIN for hashing');
    }
    const salt = crypto.randomBytes(16);
    const derivedKey = crypto.scryptSync(pin, salt, SCRYPT_PARAMS.keylen, {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
        maxmem: SCRYPT_PARAMS.maxmem
    });
    const saltHex = salt.toString('hex');
    const hashHex = derivedKey.toString('hex');
    return `scrypt$v=1$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${saltHex}$${hashHex}`;
}

/**
 * Verifies raw PIN against stored hash (scrypt or legacy fallback detection)
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * @param {string} rawPin - Raw PIN submitted by user
 * @param {string} storedHash - Stored hash from database
 * @returns {Promise<{ match: boolean, needsRehash: boolean, isDefaultBlocked: boolean }>}
 */
async function verifyPin(rawPin, storedHash) {
    if (!rawPin || !storedHash || typeof rawPin !== 'string' || typeof storedHash !== 'string') {
        return { match: false, needsRehash: false, isDefaultBlocked: false };
    }

    const cleanPin = rawPin.trim();

    // 1. Check if raw PIN is a known default
    if (isKnownDefaultPin(cleanPin)) {
        return { match: false, needsRehash: false, isDefaultBlocked: true };
    }

    // 2. Check if stored hash is in modern scrypt format
    if (storedHash.startsWith('scrypt$')) {
        const parts = storedHash.split('$');
        if (parts.length === 5) {
            const saltHex = parts[3];
            const expectedHashHex = parts[4];
            const salt = Buffer.from(saltHex, 'hex');
            const expectedBuf = Buffer.from(expectedHashHex, 'hex');

            return new Promise((resolve) => {
                crypto.scrypt(cleanPin, salt, expectedBuf.length, {
                    N: SCRYPT_PARAMS.N,
                    r: SCRYPT_PARAMS.r,
                    p: SCRYPT_PARAMS.p,
                    maxmem: SCRYPT_PARAMS.maxmem
                }, (err, derivedKey) => {
                    if (err) return resolve({ match: false, needsRehash: false, isDefaultBlocked: false });
                    if (derivedKey.length !== expectedBuf.length) {
                        return resolve({ match: false, needsRehash: false, isDefaultBlocked: false });
                    }
                    const match = crypto.timingSafeEqual(derivedKey, expectedBuf);
                    resolve({ match, needsRehash: false, isDefaultBlocked: false });
                });
            });
        }
    }

    // 3. Legacy SHA-256 fallback detection (64 hex characters)
    if (/^[a-f0-9]{64}$/i.test(storedHash)) {
        // Check if stored legacy hash matches any default pin
        for (const defaultPin of KNOWN_DEFAULT_PINS) {
            const defaultSha256 = crypto.createHash('sha256').update(defaultPin).digest('hex');
            if (storedHash.toLowerCase() === defaultSha256.toLowerCase()) {
                return { match: false, needsRehash: false, isDefaultBlocked: true };
            }
        }

        const computedSha256 = crypto.createHash('sha256').update(cleanPin).digest('hex');
        const computedBuf = Buffer.from(computedSha256, 'utf8');
        const storedBuf = Buffer.from(storedHash, 'utf8');

        if (computedBuf.length === storedBuf.length && crypto.timingSafeEqual(computedBuf, storedBuf)) {
            // Valid legacy match — signal caller that credential should be upgraded to scrypt
            return { match: true, needsRehash: true, isDefaultBlocked: false };
        }
    }

    return { match: false, needsRehash: false, isDefaultBlocked: false };
}

module.exports = {
    validatePinComplexity,
    isKnownDefaultPin,
    hashPin,
    hashPinSync,
    verifyPin
};
