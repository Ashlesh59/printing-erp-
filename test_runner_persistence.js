
        const path = require('path');
        const fs = require('fs');
        const { app } = require('electron');
        if (!app.getAppPath) app.getAppPath = () => __dirname;
        
        const { CustomerModel } = require('./src/main/database/models');
        const EventBus = require('./src/main/events/EventBus');
        const { EventTypes } = require('./src/main/events/EventTypes');
        
        async function runTest() {
            let passed = 0, failed = 0;
            const assert = (cond, msg) => { if(cond) { console.log('✅ [PASS] ' + msg); passed++; } else { console.error('❌ [FAIL] ' + msg); failed++; } };
            
            console.log("-> Testing Local ERP Operations without Cloud...");
            
            const result = CustomerModel.createCustomer({
                name: 'Offline Test Customer',
                phone: '555-000-1234',
                email: 'offline@test.com',
                company_name: 'Offline Corp'
            });
            
            assert(result.id, 'Customer created successfully offline');
            
            const fetched = CustomerModel.getCustomerProfile(result.id);
            assert(fetched && fetched.customer.name === 'Offline Test Customer', 'Customer data fully persisted to local SQLite');
            
            if (failed > 0) process.exit(1);
            process.exit(0);
        }
        
        runTest().catch(e => { console.error(e); process.exit(1); });
    