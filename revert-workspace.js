const fs = require('fs');

let html = fs.readFileSync('src/renderer/index.html', 'utf8');
const originalWorkspace = fs.readFileSync('scratch_workspace.html', 'utf8');

// 1. Revert CSS link
html = html.replace(/<link rel="stylesheet" href="\.\/css\/erp-workspace\.css">\r?\n\s*/, '');

// 2. Replace workspace block
const lines = html.split('\n');
let start = -1;
let end = -1;

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('id="workspace"')) {
        start = i;
    }
    if (start !== -1 && lines[i].includes('</section>') && i > start) {
        end = i;
        break;
    }
}

if (start !== -1 && end !== -1) {
    const before = lines.slice(0, start).join('\n');
    const after = lines.slice(end + 1).join('\n');
    
    fs.writeFileSync('src/renderer/index.html', before + '\n' + originalWorkspace + '\n' + after);
    console.log('Successfully reverted workspace and CSS link.');
} else {
    console.log('Failed to find current workspace section.');
}
