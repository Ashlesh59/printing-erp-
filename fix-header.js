const fs = require('fs');

const html = fs.readFileSync('src/renderer/index.html', 'utf8');
const lines = html.split('\n');

let start = -1;
let end = -1;
let dashStart = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<header class="top-bar"')) {
        start = i;
    }
    if (start !== -1 && lines[i].includes('</header>') && i >= start && end === -1) {
        end = i;
    }
    if (lines[i].includes('id="dashboard"') && lines[i].includes('erp-dashboard')) {
        dashStart = i;
        break;
    }
}

if (start !== -1 && end !== -1 && dashStart !== -1) {
    const before = lines.slice(0, start).join('\n');
    const after = lines.slice(dashStart + 1).join('\n');
    
    const replacement = `            <header class="top-bar" style="display: flex; justify-content: flex-end; align-items: center; padding: 12px 24px; height: 56px; box-sizing: border-box;">
                <div class="user-info" style="display: flex; gap: 16px; align-items: center;">
                    <!-- Global reload btn kept for safety if other views use it -->
                    <button id="global-reload-btn" style="display: none;"></button>
                    
                    <span id="header-user-role" style="display: none;"></span>
                    <div style="display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.05); padding: 4px 12px 4px 4px; border-radius: 20px;">
                        <span style="background: var(--text-primary); color: var(--bg-color); width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.75rem; font-weight: bold;">O</span>
                        <span id="dash-user-role" style="font-weight: 600; color: var(--text-primary); font-size: 0.85rem;">Operator</span>
                    </div>
                    <button id="shop-exit-btn" style="padding: 6px 14px; font-size: 0.8rem; font-weight: 600; background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer;">Exit Roles</button>
                </div>
            </header>

            <!-- Views -->
            <div id="views-container">
                <!-- Dashboard View -->
                <section id="dashboard" class="view erp-dashboard">
                    <!-- DASHBOARD-ONLY GREETING -->
                    <div class="dash-greeting-container" style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 24px;">
                        <div>
                            <h1 id="dash-greeting-heading" style="margin: 0 0 4px 0; font-size: 1.5rem; font-weight: 700; color: var(--text-primary); line-height: 1.2;">Good morning, Operator</h1>
                            <p id="dash-live-date" style="margin: 0; font-size: 0.85rem; color: var(--text-secondary);"></p>
                        </div>
                        <button id="dash-reload-btn" class="header-action-btn-reload" style="padding: 8px 14px; font-size: 0.82rem; font-weight: 700; border-radius: 8px !important; display: flex; align-items: center; gap: 6px; cursor: pointer; border: 1px solid var(--border-color); background: var(--surface);">
                            <span class="reload-icon">🔄</span>
                            <span>Reload</span>
                        </button>
                    </div>`;

    fs.writeFileSync('src/renderer/index.html', before + '\n' + replacement + '\n' + after);
    console.log('Successfully replaced global header block with dashboard conditional rendering structure.');
} else {
    console.log('Target string not found. Please verify the lines.');
}
