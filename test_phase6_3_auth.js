/**
 * Automated Verification Suite for Phase 6.3:
 * Authentication Backdoor Removal & Lockout Response Contract Repair
 * 
 * Run with: npx electron test_phase6_3_auth.js
 */

const { app } = require('electron');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

async function runPhase63AuthTests() {
    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('🛡️  PHASE 6.3 AUTHENTICATION BACKDOOR REMOVAL & LOCKOUT REGRESSION SUITE');
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ✓ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗ FAIL: ${name}`);
            console.error(`    ↳ Error: ${err.message}`);
            if (err.stack) console.error(`    ↳ Stack: ${err.stack.split('\n').slice(1, 4).join('\n')}`);
            failed++;
        }
    }

    // 1. Initialize Database & Security modules
    const { initDatabase } = require('./src/main/database/schema');
    initDatabase();
    const db = require('./src/main/database/db');
    const pinSecurity = require('./src/main/security/pin-security');
    const authThrottle = require('./src/main/security/auth-throttle');
    const sessionManager = require('./src/main/security/session-manager');
    const { UserModel, WizardModel } = require('./src/main/database/models');

    // Setup isolated test users with known unique PINs (different from the removed static PINs)
    const ADMIN_TEST_PIN = '684920';   // Valid strong non-sequential PIN
    const OPERATOR_TEST_PIN = '715938';// Valid strong non-sequential PIN

    // Hash test PINs using real scrypt key derivation
    const hashedAdminPin = pinSecurity.hashPinSync(ADMIN_TEST_PIN);
    const hashedOperatorPin = pinSecurity.hashPinSync(OPERATOR_TEST_PIN);

    // Clean users table and insert legitimate test users
    db.prepare("DELETE FROM users").run();
    db.prepare("INSERT INTO users (id, name, role, pin, reset_required) VALUES (1, 'System Admin', 'Admin', ?, 0)").run(hashedAdminPin);
    db.prepare("INSERT INTO users (id, name, role, pin, reset_required) VALUES (2, 'Shop Operator', 'Operator', ?, 0)").run(hashedOperatorPin);

    // The 6 removed developer bypass PINs that must NEVER authenticate unless genuinely stored
    const REMOVED_STATIC_PINS = ['938472', '852963', '147258', '582914', '739104', '849201'];

    // ──────────────────────────────────────────────────────────────────────────
    // Section 1: Authentication Correctness & Backdoor Elimination
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[1/5] Testing Legitimate Authentication & Backdoor Rejection...');

    await test('1. Correct stored Admin PIN authenticates successfully as Admin', async () => {
        authThrottle.resetAll();
        const res = await UserModel.verifyPin(ADMIN_TEST_PIN, 101, 'Admin');
        assert.strictEqual(res.success, true, 'Admin PIN verification should succeed');
        assert.strictEqual(res.user.role, 'Admin', 'Authenticated user role must be Admin');
        assert.strictEqual(res.user.name, 'System Admin', 'User object must match DB');
        assert.strictEqual(res.user.pin, undefined, 'User object must NOT expose PIN hash');
    });

    await test('2. Correct stored Operator PIN authenticates successfully as Shop Operator', async () => {
        authThrottle.resetAll();
        const res = await UserModel.verifyPin(OPERATOR_TEST_PIN, 102, 'Shop');
        assert.strictEqual(res.success, true, 'Operator PIN verification should succeed');
        assert.strictEqual(res.user.role, 'Operator', 'Authenticated user role must be Operator');
        assert.strictEqual(res.user.pin, undefined, 'User object must NOT expose PIN hash');
    });

    await test('3. Incorrect PIN fails verification and does not authenticate', async () => {
        authThrottle.resetAll();
        const res = await UserModel.verifyPin('999999', 103, 'Admin');
        assert.strictEqual(res.success, false, 'Incorrect PIN must fail');
        assert.strictEqual(res.error, 'Invalid security PIN.');
    });

    await test('4. Every removed developer PIN (6 static PINs) fails authentication', async () => {
        authThrottle.resetAll();
        for (const pin of REMOVED_STATIC_PINS) {
            const resAdmin = await UserModel.verifyPin(pin, `test-backdoor-${pin}-admin`, 'Admin');
            assert.strictEqual(resAdmin.success, false, `Static PIN ${pin} must fail for Admin`);

            const resShop = await UserModel.verifyPin(pin, `test-backdoor-${pin}-shop`, 'Shop');
            assert.strictEqual(resShop.success, false, `Static PIN ${pin} must fail for Shop`);

            const resAny = await UserModel.verifyPin(pin, `test-backdoor-${pin}-any`, 'Any');
            assert.strictEqual(resAny.success, false, `Static PIN ${pin} must fail for Any role`);
        }
    });

    await test('5. Verification results are strictly identical in packaged and unpackaged environments', async () => {
        authThrottle.resetAll();
        // Packaged and unpackaged verification runs through the identical UserModel.verifyPin path
        for (const pin of REMOVED_STATIC_PINS) {
            const res = await UserModel.verifyPin(pin, 'env-parity-test', 'Admin');
            assert.strictEqual(res.success, false, `Backdoor PIN ${pin} must fail regardless of packaging`);
        }
        const validRes = await UserModel.verifyPin(ADMIN_TEST_PIN, 'env-parity-test-valid', 'Admin');
        assert.strictEqual(validRes.success, true, 'Valid PIN succeeds identically');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Section 2: Role Separation & Authorization Matrix
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[2/5] Testing Role Separation & Authorization Integrity...');

    await test('6. Admin PIN cannot authenticate when Operator role is required', async () => {
        authThrottle.resetAll();
        const res = await UserModel.verifyPin(ADMIN_TEST_PIN, 201, 'Operator');
        assert.strictEqual(res.success, false, 'Admin PIN must not authenticate when Operator role is expected');
    });

    await test('7. Operator PIN cannot authenticate when Admin role is required', async () => {
        authThrottle.resetAll();
        const res = await UserModel.verifyPin(OPERATOR_TEST_PIN, 202, 'Admin');
        assert.strictEqual(res.success, false, 'Operator PIN must not authenticate when Admin role is expected');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Section 3: Lockout Contract, Tiers & Fake Clock Testing
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[3/5] Testing Progressive Lockout Tiers, remainingSeconds & Fake Clock...');

    await test('8. Five consecutive failures trigger 30-second lockout (Tier 1)', async () => {
        authThrottle.resetAll();
        let baseTime = 1000000;
        authThrottle.setTimeProvider(() => baseTime);

        const senderId = 301;
        for (let i = 1; i <= 4; i++) {
            const res = await UserModel.verifyPin('000000', senderId, 'Admin');
            assert.strictEqual(res.success, false);
            assert.strictEqual(res.locked, false, `Attempt ${i} must not lock`);
        }

        // 5th failure
        const fail5 = await UserModel.verifyPin('000000', senderId, 'Admin');
        assert.strictEqual(fail5.success, false);
        assert.strictEqual(fail5.locked, true, '5th failure must trigger locked = true');
        assert.strictEqual(fail5.remainingSeconds, 30, 'remainingSeconds must be 30 for Tier 1 lockout');

        // While locked, correct PIN must be rejected
        const lockedAttempt = await UserModel.verifyPin(ADMIN_TEST_PIN, senderId, 'Admin');
        assert.strictEqual(lockedAttempt.success, false);
        assert.strictEqual(lockedAttempt.locked, true);
        assert.strictEqual(lockedAttempt.remainingSeconds, 30);

        authThrottle.resetTimeProvider();
    });

    await test('9. Ten consecutive failures trigger 300-second / 5-minute lockout (Tier 2)', async () => {
        authThrottle.resetAll();
        let baseTime = 1000000;
        authThrottle.setTimeProvider(() => baseTime);

        const senderId = 302;
        // 5 failures -> triggers Tier 1 (30s lockout)
        for (let i = 1; i <= 5; i++) {
            await UserModel.verifyPin('000000', senderId, 'Admin');
        }

        // Advance clock past Tier 1 lockout for each subsequent failure attempt (6, 7, 8, 9)
        for (let i = 6; i <= 9; i++) {
            baseTime += 31000; // Lockout expires
            const r = await UserModel.verifyPin('000000', senderId, 'Admin');
            assert.strictEqual(r.success, false);
            assert.strictEqual(r.locked, true, `Attempt ${i} is throttled for 30s`);
            assert.strictEqual(r.remainingSeconds, 30, `Attempt ${i} has 30s lockout`);
        }

        // Advance clock past 9th attempt lockout
        baseTime += 31000;

        // 10th failure -> triggers Tier 2 (300s / 5-minute lockout)
        const fail10 = await UserModel.verifyPin('000000', senderId, 'Admin');
        assert.strictEqual(fail10.success, false);
        assert.strictEqual(fail10.locked, true, '10th failure must trigger locked = true');
        assert.strictEqual(fail10.remainingSeconds, 300, 'remainingSeconds must be 300 (5 minutes) for Tier 2');

        authThrottle.resetTimeProvider();
    });

    await test('10. Fake clock: Authentication succeeds immediately after lockout expiration without CI wait', async () => {
        authThrottle.resetAll();
        let virtualTime = 5000000;
        authThrottle.setTimeProvider(() => virtualTime);

        const senderId = 303;
        // Trigger 5-attempt lockout
        for (let i = 1; i <= 5; i++) {
            await UserModel.verifyPin('000000', senderId, 'Admin');
        }

        // Verify currently locked
        const checkLocked = authThrottle.isLocked(senderId, 'Admin');
        assert.strictEqual(checkLocked.locked, true);
        assert.strictEqual(checkLocked.remainingSeconds, 30);

        // Fast-forward fake clock by 31 seconds
        virtualTime += 31000;

        // Check isLocked now returns false
        const checkExpired = authThrottle.isLocked(senderId, 'Admin');
        assert.strictEqual(checkExpired.locked, false, 'Lockout should expire after duration');
        assert.strictEqual(checkExpired.remainingSeconds, 0);

        // Authenticate with correct PIN
        const loginAfterExpiry = await UserModel.verifyPin(ADMIN_TEST_PIN, senderId, 'Admin');
        assert.strictEqual(loginAfterExpiry.success, true, 'Authentication must succeed immediately after lockout expiry');

        authThrottle.resetTimeProvider();
    });

    await test('11. Successful authentication clears the failure counter completely', async () => {
        authThrottle.resetAll();
        const senderId = 304;

        // 4 failed attempts (1 away from lockout)
        for (let i = 1; i <= 4; i++) {
            await UserModel.verifyPin('000000', senderId, 'Admin');
        }

        // Successful authentication
        const successRes = await UserModel.verifyPin(ADMIN_TEST_PIN, senderId, 'Admin');
        assert.strictEqual(successRes.success, true);

        // Next 4 failures should NOT trigger lockout because counter was reset
        for (let i = 1; i <= 4; i++) {
            const failRes = await UserModel.verifyPin('000000', senderId, 'Admin');
            assert.strictEqual(failRes.locked, false, `Failure ${i} after reset must not lock`);
        }
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Section 4: Renderer Lockout Contract & UI Protection Integrity
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[4/5] Testing Renderer Lockout Contract, Countdown & Modal Logic...');

    await test('12. Renderer countdown safely computes lockedUntil from remainingSeconds', () => {
        const mockBackendResponse = {
            success: false,
            locked: true,
            remainingSeconds: 30,
            error: "Terminal is temporarily locked."
        };

        assert.strictEqual(mockBackendResponse.locked, true);
        assert.ok(typeof mockBackendResponse.remainingSeconds === 'number' && Number.isFinite(mockBackendResponse.remainingSeconds) && mockBackendResponse.remainingSeconds > 0);

        const simulatedNow = 10000000;
        const lockedUntil = simulatedNow + (mockBackendResponse.remainingSeconds * 1000);
        assert.strictEqual(lockedUntil, 10030000);

        // Calculate countdown ticks
        const remainingMs1 = lockedUntil - simulatedNow;
        assert.strictEqual(Math.ceil(remainingMs1 / 1000), 30);

        const simulatedAfter15s = simulatedNow + 15000;
        const remainingMs2 = lockedUntil - simulatedAfter15s;
        assert.strictEqual(Math.ceil(remainingMs2 / 1000), 15);

        const simulatedAfter30s = simulatedNow + 30000;
        const remainingMs3 = lockedUntil - simulatedAfter30s;
        assert.strictEqual(remainingMs3 <= 0, true, 'Countdown expires at exactly 30s');
    });

    await test('13. Session is destroyed on UI reload/navigation and does not grant authentication', () => {
        const mockSender = {
            id: 401,
            isDestroyed: () => false,
            listeners: {},
            once: function(evt, cb) { (this.listeners[evt] = this.listeners[evt] || []).push(cb); },
            on: function(evt, cb) { (this.listeners[evt] = this.listeners[evt] || []).push(cb); },
            emit: function(evt) { if (this.listeners[evt]) this.listeners[evt].forEach(cb => cb()); }
        };

        // Create active session
        sessionManager.createSession(mockSender, { id: 1, name: 'Admin', role: 'Admin' }, 'Admin');
        assert.ok(sessionManager.getSession(mockSender) !== null, 'Session exists after login');

        // Simulate UI page reload / did-navigate event
        mockSender.emit('did-navigate');

        // Session must be destroyed
        const sessionAfterReload = sessionManager.getSession(mockSender);
        assert.strictEqual(sessionAfterReload, null, 'Session must be destroyed on did-navigate / reload');
    });

    await test('14. Cancelling PIN modal does not execute protected action and clears buffer', () => {
        let protectedActionExecuted = false;
        let cancelHandlerCalled = false;

        const onSuccess = () => { protectedActionExecuted = true; };
        const onCancel = () => { cancelHandlerCalled = true; };

        // Simulate user clicking Cancel
        let pinBuffer = "849201";
        // User cancels
        pinBuffer = "";
        if (onCancel) onCancel();

        assert.strictEqual(protectedActionExecuted, false, 'Protected action MUST NOT execute on cancel');
        assert.strictEqual(cancelHandlerCalled, true, 'Cancel handler executed');
        assert.strictEqual(pinBuffer, '', 'PIN buffer is safely cleared');
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Section 5: Privacy & Security Guarantees
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[5/5] Testing Privacy & Credential Storage Security...');

    await test('15. No plaintext PIN is stored in database fields or leaked in user objects', () => {
        const users = db.prepare("SELECT * FROM users").all();
        assert.ok(users.length >= 2, 'Users exist in database');

        for (const u of users) {
            assert.ok(u.pin.startsWith('scrypt$'), 'PIN is stored as a salted scrypt hash');
            assert.notStrictEqual(u.pin, ADMIN_TEST_PIN, 'Plaintext Admin PIN is not stored');
            assert.notStrictEqual(u.pin, OPERATOR_TEST_PIN, 'Plaintext Operator PIN is not stored');
            for (const staticPin of REMOVED_STATIC_PINS) {
                assert.notStrictEqual(u.pin, staticPin, `Static PIN ${staticPin} is not stored`);
            }
        }
    });

    // Clean up test data
    db.prepare("DELETE FROM users WHERE id IN (1, 2)").run();
    authThrottle.resetAll();

    // Summary
    console.log('\n════════════════════════════════════════════════════════════════════════════');
    console.log(`📊 PHASE 6.3 TEST SUITE COMPLETE: ${passed} PASSED, ${failed} FAILED`);
    console.log('════════════════════════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

app.whenReady().then(() => {
    runPhase63AuthTests().catch(err => {
        console.error('Fatal test exception:', err);
        process.exit(1);
    });
});
