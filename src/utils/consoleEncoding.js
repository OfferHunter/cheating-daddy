const { spawnSync } = require('child_process');

// Windows consoles default to the OEM code page (936 on a zh-CN machine), which misreads the UTF-8
// bytes Node writes, so Chinese transcripts print as mojibake. Node has no binding for
// SetConsoleOutputCP, so shell out to chcp. The code page is a property of the console rather than
// the process, which is why this reaches the terminal that launched the app.
//
// Deliberately no `windowsHide`: it maps to CREATE_NO_WINDOW, which can stop the child from
// inheriting the parent's console and silently turn this into a no-op. Verified on Windows 11 that
// a child spawned this way does move the shared console to 65001.
function enableUtf8Console() {
    if (process.platform !== 'win32') return;

    try {
        spawnSync('chcp.com', ['65001'], { stdio: 'ignore' });
    } catch (error) {
        console.warn('Could not switch the console to UTF-8:', error.message);
    }
}

module.exports = {
    enableUtf8Console,
};
