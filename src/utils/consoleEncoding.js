const { spawnSync } = require('child_process');

// Windows 控制台默认是 OEM 代码页（中文机器上是 936），会把 Node 写出的 UTF-8 字节读成乱码，中文
// 字幕在终端里全是花屏。Node 没有 SetConsoleOutputCP 的绑定，只能起进程跑 chcp。
// 故意不传 `windowsHide`：它对应 CREATE_NO_WINDOW，会让子进程继承不到父进程的控制台，使这行变成
// 静默的空操作。已在 Windows 11 上验证过这样起进程确实把控制台切到了 65001。
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
