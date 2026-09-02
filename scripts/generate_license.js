/**
 * Offline Ed25519 Digital License Generator Tool
 * 
 * Usage:
 *   node scripts/generate_license.js --privateKey=<path_to_pem_or_env> --tier=PRO --days=365
 * 
 * DO NOT COMMIT PRODUCTION PRIVATE KEYS TO GIT.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateLicenseToken(privateKeyPem, payload = {}) {
    const defaultPayload = {
        licenseId: `LIC-${Date.now()}-${crypto.randomUUID().substring(0, 8).toUpperCase()}`,
        product: 'PrintShopManager',
        tier: payload.tier || 'PRO',
        issuedAt: new Date().toISOString(),
        expiresAt: payload.expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        maxDevices: payload.maxDevices || 5,
        features: payload.features || ['print_studio', 'inventory_erp', 'multi_terminal', 'purchasing_ledger', 'gst_invoicing']
    };

    const finalPayload = { ...defaultPayload, ...payload };
    const payloadBuffer = Buffer.from(JSON.stringify(finalPayload), 'utf8');

    const signature = crypto.sign(null, payloadBuffer, privateKeyPem);

    const b64Payload = payloadBuffer.toString('base64');
    const b64Signature = signature.toString('base64');

    return `PSM-ED25519.${b64Payload}.${b64Signature}`;
}

// If executed directly
if (require.main === module) {
    console.log('=== PrintShop Manager Offline License Generator ===');
    // Generate an ephemeral keypair for offline demo/test if private key not supplied
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    const sampleToken = generateLicenseToken(privPem, { tier: 'PRO', days: 365 });
    console.log('\nSample Generated License Token:');
    console.log(sampleToken);
    console.log('\nMatching Public Key (SPKI):');
    console.log(pubPem);
}

module.exports = { generateLicenseToken };
