/**
 * Automated Verification Suite for Phase 1 Security & Authorization Hardening
 * Run with: npx electron test_phase1_security.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

async function runTests() {
    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('🛡️  PHASE 1 SECURITY & AUTHORIZATION AUTOMATED VERIFICATION SUITE');
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    let passed = 0;
    let failed = 0;

    function assert(condition, testName, details = '') {
        if (condition) {
            console.log(`  ✓ PASS: ${testName}`);
            passed++;
        } else {
            console.error(`  ✗ FAIL: ${testName}`);
            if (details) console.error(`    ↳ Details: ${details}`);
            failed++;
        }
    }

    // Initialize Database
    const { initDatabase } = require('./src/main/database/schema');
    initDatabase();
    const db = require('./src/main/database/db');

    // ──────────────────────────────────────────────────────────────
    // 1. PIN SECURITY (scrypt hashing, salt, timing-safe verification)
    // ──────────────────────────────────────────────────────────────
    console.log('\n[1/7] Testing PIN Security & scrypt Key Derivation...');
    const pinSecurity = require('./src/main/security/pin-security');

    const formattedHash1 = pinSecurity.hashPinSync('839201');
    const formattedHash2 = pinSecurity.hashPinSync('839201');
    const parts1 = formattedHash1.split('$');
    const parts2 = formattedHash2.split('$');

    assert(parts1.length === 5 && parts1[0] === 'scrypt', 'Hash string is in valid modular scrypt format');
    assert(parts1[3].length === 32, 'Salt is a 16-byte random hex string (32 chars)');
    assert(parts1[4].length === 64, 'Hash is a 32-byte scrypt hex string (64 chars)');
    assert(parts1[3] !== parts2[3], 'Consecutive hash calls generate unique salts');
    assert(parts1[4] !== parts2[4], 'Consecutive hash calls generate unique hashes for same PIN');

    const verifyMatch = await pinSecurity.verifyPin('839201', formattedHash1);
    assert(verifyMatch.match === true, 'Timing-safe verification succeeds for matching PIN');

    const verifyWrong = await pinSecurity.verifyPin('948201', formattedHash1);
    assert(verifyWrong.match === false, 'Timing-safe verification fails for incorrect PIN');

    // Legacy SHA-256 auto-upgrade test
    const crypto = require('crypto');
    const legacySha256 = crypto.createHash('sha256').update('759302').digest('hex');
    const legacyVerify = await pinSecurity.verifyPin('759302', legacySha256);
    assert(legacyVerify.match === true && legacyVerify.needsRehash === true, 
        'Legacy SHA-256 PIN verifies and signals needsRehash=true for automatic upgrade');

    // ──────────────────────────────────────────────────────────────
    // 2. PIN COMPLEXITY & DEFAULT CREDENTIAL REJECTION
    // ──────────────────────────────────────────────────────────────
    console.log('\n[2/7] Testing PIN Complexity & Weak Credential Blocking...');
    
    assert(pinSecurity.validatePinComplexity('1234').valid === false, 'Rejects 4-digit PIN (1234)');
    assert(pinSecurity.validatePinComplexity('5678').valid === false, 'Rejects 4-digit PIN (5678)');
    assert(pinSecurity.validatePinComplexity('123456').valid === false, 'Rejects ascending sequential (123456)');
    assert(pinSecurity.validatePinComplexity('654321').valid === false, 'Rejects descending sequential (654321)');
    assert(pinSecurity.validatePinComplexity('000000').valid === false, 'Rejects repeated zeros (000000)');
    assert(pinSecurity.validatePinComplexity('111111').valid === false, 'Rejects repeated ones (111111)');
    assert(pinSecurity.validatePinComplexity('888888').valid === false, 'Rejects repeated eights (888888)');
    assert(pinSecurity.validatePinComplexity('abcdef').valid === false, 'Rejects non-numeric input (abcdef)');
    assert(pinSecurity.validatePinComplexity('1234567890123').valid === false, 'Rejects >12 digits');

    const validComplexPin = pinSecurity.validatePinComplexity('849201');
    assert(validComplexPin.valid === true, 'Accepts strong non-sequential 6-digit PIN (849201)');
    const validComplex10 = pinSecurity.validatePinComplexity('9283746150');
    assert(validComplex10.valid === true, 'Accepts strong non-sequential 10-digit PIN (9283746150)');

    // ──────────────────────────────────────────────────────────────
    // 3. AUTHENTICATION THROTTLING & LOCKOUT
    // ──────────────────────────────────────────────────────────────
    console.log('\n[3/7] Testing Auth Throttling & Brute-Force Rate Limiting...');
    const authThrottle = require('./src/main/security/auth-throttle');

    const testSender = 9999;
    authThrottle.resetAll();

    assert(authThrottle.isLocked(testSender).locked === false, 'Sender starts unlocked');

    // Record 4 failures
    for (let i = 1; i <= 4; i++) {
        authThrottle.recordFailure(testSender);
    }
    assert(authThrottle.isLocked(testSender).locked === false, '4 failures do not trigger lockout');

    // 5th failure triggers 30s lockout
    const fail5 = authThrottle.recordFailure(testSender);
    assert(fail5.locked === true && fail5.remainingSeconds > 25, '5th failure triggers 30-second lockout');
    assert(authThrottle.isLocked(testSender).locked === true, 'isLocked returns locked=true during active lockout');

    // Reset sender
    authThrottle.recordSuccess(testSender);
    assert(authThrottle.isLocked(testSender).locked === false, 'Successful login clears lockout');

    // ──────────────────────────────────────────────────────────────
    // 4. MAIN PROCESS AUTHORITATIVE SESSION MANAGER
    // ──────────────────────────────────────────────────────────────
    console.log('\n[4/7] Testing Main Process Session Manager...');
    const sessionManager = require('./src/main/security/session-manager');

    // Mock webContents
    const mockSender = { id: 101, isDestroyed: () => false, on: () => {} };
    sessionManager.destroySession(mockSender);

    assert(sessionManager.getSession(mockSender) === null, 'Session is null before authentication');
    assert(sessionManager.requireRole(mockSender, ['Admin']).authorized === false, 'requireRole rejects unauthenticated sender');

    // Create session for Operator
    sessionManager.createSession(mockSender, { id: 2, name: 'Operator User', role: 'Operator' }, 'Operator');
    const session = sessionManager.getSession(mockSender);
    assert(session !== null && session.role === 'Operator', 'createSession establishes Operator session');
    assert(sessionManager.requireRole(mockSender, ['Operator', 'Manager', 'Admin']).authorized === true, 'Operator authorized for OPERATOR level');
    assert(sessionManager.requireRole(mockSender, ['Admin']).authorized === false, 'Operator denied for ADMIN level');

    // Create Kiosk session
    const mockKiosk = { id: 102, isDestroyed: () => false, on: () => {} };
    sessionManager.createKioskSession(mockKiosk);
    assert(sessionManager.requireRole(mockKiosk, ['Customer']).authorized === true, 'Kiosk authorized for CUSTOMER role');
    assert(sessionManager.requireRole(mockKiosk, ['Operator', 'Admin']).authorized === false, 'Kiosk denied for OPERATOR/ADMIN roles');

    // ──────────────────────────────────────────────────────────────
    // 5. IPC GUARD & PERMISSION MATRIX
    // ──────────────────────────────────────────────────────────────
    console.log('\n[5/7] Testing IPC Guard Enforcement...');
    const { ROLES, createGuardedWrapper } = require('./src/main/security/ipc-guard');

    // Test a guarded admin handler
    let adminActionExecuted = false;
    const handler = createGuardedWrapper('test:admin-action', ROLES.ADMIN, async (event, payload) => {
        adminActionExecuted = true;
        return { success: true, payload };
    });

    assert(typeof handler === 'function', 'createGuardedWrapper creates wrapper function');

    // Unauthenticated call
    const unauthRes = await handler({ sender: { id: 999 } }, { test: 1 });
    assert(unauthRes.success === false && unauthRes.code === 'UNAUTHORIZED', 'Guard blocks unauthenticated sender with UNAUTHORIZED');

    // Operator calling Admin endpoint
    const opSender = { id: 101 }; // Operator session from test 4
    const forbiddenRes = await handler({ sender: opSender }, { test: 1 });
    assert(forbiddenRes.success === false && forbiddenRes.code === 'FORBIDDEN', 'Guard blocks Operator calling Admin endpoint with FORBIDDEN');

    // Admin calling Admin endpoint
    const adminSender = { id: 103, isDestroyed: () => false, on: () => {} };
    sessionManager.createSession(adminSender, { id: 1, name: 'Admin', role: 'Admin' }, 'Admin');
    const allowedRes = await handler({ sender: adminSender }, { test: 1 });
    assert(allowedRes.success === true && allowedRes.payload.test === 1, 'Guard permits Admin calling Admin endpoint');

    // ──────────────────────────────────────────────────────────────
    // 6. LICENSE SERVICE & FAIL-CLOSED ENFORCEMENT
    // ──────────────────────────────────────────────────────────────
    console.log('\n[6/7] Testing License Service (Fail-Closed & HMAC)...');
    const { LicenseService, LicenseState } = require('./src/main/security/license-service');

    // Generate valid license
    const validKey = LicenseService.generateSignedKey('PRO', '20281231', 'A8B9');
    const keyParts = validKey.split('-');
    assert(keyParts.length === 5 && keyParts[0] === 'PSM' && keyParts[1] === 'PRO', 'generateSignedKey creates valid structure');

    const verifyKey = LicenseService.verifyLicenseKey(validKey);
    assert(verifyKey.state === LicenseState.VALID && verifyKey.valid === true, 'Valid signed license verifies successfully');

    // Tampered key
    const tamperedKey = validKey.slice(0, -4) + 'AAAA';
    const verifyTampered = LicenseService.verifyLicenseKey(tamperedKey);
    assert(verifyTampered.valid === false && verifyTampered.state === LicenseState.INVALID, 'Tampered HMAC signature is rejected as INVALID');

    // Short / random strings
    assert(LicenseService.verifyLicenseKey('1234').valid === false, 'Rejects trivial 4-character license (1234)');
    assert(LicenseService.verifyLicenseKey('abcd-efgh-ijkl-mnop').valid === false, 'Rejects arbitrary formatted license');

    // Test activation and retrieval
    const actRes = LicenseService.activateLicense(validKey);
    assert(actRes.success === true, 'License activation succeeds for valid key');
    const status = LicenseService.checkLicenseStatus();
    assert(status.valid === true && status.state === LicenseState.VALID, 'checkLicenseStatus returns valid active license');

    // ──────────────────────────────────────────────────────────────
    // 7. SETUP WIZARD WITH COMPLEXITY & MATCHING PINS
    // ──────────────────────────────────────────────────────────────
    console.log('\n[7/7] Testing Setup Wizard Execution & UserModel Security...');
    const { UserModel, WizardModel, SettingsModel } = require('./src/main/database/models');

    // Weak admin PIN in wizard
    const weakWz = await WizardModel.executeWizardSetup({
        businessName: 'Secure Print Shop',
        adminPin: '123456', // sequential
        confirmAdminPin: '123456',
        managerPin: '849201',
        confirmManagerPin: '849201'
    });
    assert(weakWz.success === false, 'Setup Wizard rejects weak sequential Admin PIN');

    // Mismatched admin PIN in wizard
    const mismatchWz = await WizardModel.executeWizardSetup({
        businessName: 'Secure Print Shop',
        adminPin: '849201',
        confirmAdminPin: '849202',
        managerPin: '739104',
        confirmManagerPin: '739104'
    });
    assert(mismatchWz.success === false, 'Setup Wizard rejects mismatched Admin PIN confirmation');

    // Matching distinct valid PINs
    const validWz = await WizardModel.executeWizardSetup({
        businessName: 'Secure Print Shop',
        phone: '9876543210',
        currency: '₹',
        adminPin: '849201',
        confirmAdminPin: '849201',
        managerPin: '739104',
        confirmManagerPin: '739104',
        papers: ['A4', 'A3'],
        services: ['bw_print', 'color_print']
    });
    assert(validWz.success === true, 'Setup Wizard completes successfully with valid confirmed PINs');

    // Verify created users in DB
    const adminUser = db.prepare("SELECT * FROM users WHERE role = 'Admin'").get();
    assert(adminUser !== undefined, 'Admin user created in database');
    assert(adminUser.pin.startsWith('scrypt$'), 'Admin user PIN stored in scrypt format');
    assert(adminUser.pin !== '849201', 'Plaintext PIN is NOT stored in database');

    // Test UserModel.verifyPin
    const loginAdmin = await UserModel.verifyPin('849201', 201, 'Admin');
    assert(loginAdmin.success === true && loginAdmin.user.role === 'Admin', 'UserModel.verifyPin successfully authenticates Admin');

    const loginWrong = await UserModel.verifyPin('999999', 201, 'Admin');
    assert(loginWrong.success === false, 'UserModel.verifyPin rejects incorrect Admin PIN');

    // Summary
    console.log('\n════════════════════════════════════════════════════════════════════════════');
    console.log(`📊 TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

app.whenReady().then(() => {
    runTests().catch(err => {
        console.error('Test runner exception:', err);
        process.exit(1);
    });
});
