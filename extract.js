const fs = require('fs');
const lines = fs.readFileSync('src/renderer/index.html', 'utf8').split('\n');
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
    fs.writeFileSync('scratch_workspace.html', lines.slice(start, end + 1).join('\n'));
    console.log(`Extracted lines ${start} to ${end}`);
} else {
    console.log('Not found');
}
