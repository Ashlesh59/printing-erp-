/**
 * Offline Ed25519 Digital License Generator Tool
 * 
 * Usage:
 *   # Production generation with private key:
 *   node scripts/generate_license.js --private-key=./private.pem --tier=PRO --days=365 --shop-name="Apex Prints"
 * 
 *   # Demo keypair generation for testing:
 *   node scripts/generate_license.js --demo --tier=PRO --days=30
 * 
 * DO NOT COMMIT PRODUCTION PRIVATE KEYS TO GIT.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(args) {
    const options = {};
    for (const arg of args) {
        if (arg.startsWith('--')) {
            const equalIdx = arg.indexOf('=');
            if (equalIdx !== -1) {
                const key = arg.slice(2, equalIdx).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                const rawKey = arg.slice(2, equalIdx);
                const value = arg.slice(equalIdx + 1);
                options[key] = value;
                options[rawKey] = value;
            } else {
                const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                const rawKey = arg.slice(2);
                options[key] = true;
                options[rawKey] = true;
            }
        }
    }
    return options;
}

function generateLicenseToken(privateKeyPem, payload = {}) {
    const days = parseInt(payload.days, 10) || 365;
    const expiresAt = payload.expiresAt || new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const defaultPayload = {
        licenseId: payload.licenseId || payload['license-id'] || `LIC-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        product: 'PrintShopManager',
        tier: String(payload.tier || 'PRO').toUpperCase(),
        shopId: payload.shopId || payload['shop-id'] || 'SHOP-DEFAULT',
        shopName: payload.shopName || payload['shop-name'] || 'Authorized Print Shop',
        issuedAt: payload.issuedAt || new Date().toISOString(),
        expiresAt: expiresAt,
        maxDevices: parseInt(payload.maxDevices || payload['max-devices'], 10) || 5,
        features: payload.features || ['print_studio', 'inventory_erp', 'multi_terminal', 'purchasing_ledger', 'gst_invoicing']
    };

    const finalPayload = { ...defaultPayload, ...payload };
    delete finalPayload.days;

    const payloadBuffer = Buffer.from(JSON.stringify(finalPayload), 'utf8');
    const signature = crypto.sign(null, payloadBuffer, privateKeyPem);

    const b64Payload = payloadBuffer.toString('base64');
    const b64Signature = signature.toString('base64');

    return `PSM-ED25519.${b64Payload}.${b64Signature}`;
}

// If executed directly from CLI
if (require.main === module) {
    const args = parseArgs(process.argv.slice(2));

    console.log('════════════════════════════════════════════════════════════════');
    console.log('🛡️  PrintShopManager Offline Ed25519 License Generator');
    console.log('════════════════════════════════════════════════════════════════\n');

    if (args.help || args.h || (Object.keys(args).length === 0)) {
        console.log('Usage:');
        console.log('  node scripts/generate_license.js --private-key=<path> [options]');
        console.log('  node scripts/generate_license.js --demo [options]\n');
        console.log('Options:');
        console.log('  --private-key=<path>    Path to Ed25519 PKCS8 PEM private key');
        console.log('  --demo                  Generate ephemeral test keypair & demo token');
        console.log('  --tier=<tier>           STARTER | PRO | ENTERPRISE (default: PRO)');
        console.log('  --days=<number>         Days until expiration (default: 365)');
        console.log('  --license-id=<id>       Custom license identifier');
        console.log('  --shop-id=<id>          Licensed store ID');
        console.log('  --shop-name=<name>      Licensed store name');
        console.log('  --max-devices=<number>  Maximum concurrent device activations');
        process.exit(args.help ? 0 : 1);
    }

    let privKeyPem;
    let pubKeyPem;

    if (args.demo) {
        console.log('[Notice] --demo flag passed: Generating ephemeral Ed25519 keypair for local test...');
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        pubKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
        privKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    } else {
        const privPath = args.privateKey || args['private-key'];
        if (!privPath) {
            console.error('❌ Error: Missing required --private-key argument.');
            console.error('   To generate a test demo keypair, pass the explicit --demo flag.');
            process.exit(1);
        }

        if (!fs.existsSync(privPath)) {
            console.error(`❌ Error: Private key file not found at: ${privPath}`);
            process.exit(1);
        }

        privKeyPem = fs.readFileSync(privPath, 'utf8');
    }

    const tier = String(args.tier || 'PRO').toUpperCase();
    const allowedTiers = ['STARTER', 'PRO', 'ENTERPRISE', 'COMMUNITY', 'COMMERCIAL'];
    if (!allowedTiers.includes(tier)) {
        console.error(`❌ Error: Invalid tier '${tier}'. Allowed tiers: ${allowedTiers.join(', ')}`);
        process.exit(1);
    }

    const days = parseInt(args.days, 10) || 365;
    if (isNaN(days) || days <= 0) {
        console.error(`❌ Error: Invalid --days parameter: must be a positive integer.`);
        process.exit(1);
    }

    const token = generateLicenseToken(privKeyPem, {
        tier,
        days,
        licenseId: args.licenseId || args['license-id'],
        shopId: args.shopId || args['shop-id'],
        shopName: args.shopName || args['shop-name'],
        maxDevices: parseInt(args.maxDevices || args['max-devices'], 10) || 5
    });

    console.log('Generated License Token:');
    console.log('----------------------------------------------------------------');
    console.log(token);
    console.log('----------------------------------------------------------------\n');

    if (pubKeyPem) {
        console.log('Matching Ephemeral Public Key (SPKI PEM):');
        console.log(pubKeyPem);
    }
}

module.exports = { generateLicenseToken, parseArgs };
