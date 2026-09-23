const fs = require('fs');
const oldHtml = fs.readFileSync('src/renderer/index.html', 'utf8');
const newBlock = fs.readFileSync('workspace-new.html', 'utf8');

const lines = oldHtml.split('\n');
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
    
    // Ensure newBlock does not have trailing/leading empty lines that duplicate
    fs.writeFileSync('src/renderer/index.html', before + '\n' + newBlock + '\n' + after);
    console.log(`Successfully replaced lines ${start} to ${end}`);
} else {
    console.log('Failed to find workspace section.');
}
