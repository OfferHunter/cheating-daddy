// 主进程 (window.js) 与设置页 (CustomizeView.js) 共用这一份默认键位表。两边各抄一份的时候漂移不是中性的：
// 注册处都被 `if (keybinds.X)` 守着，缺的那个键会静默地永不注册。
function getDefaultKeybinds() {
    const isMac = process.platform === 'darwin';
    return {
        moveUp: isMac ? 'Alt+Up' : 'Ctrl+Up',
        moveDown: isMac ? 'Alt+Down' : 'Ctrl+Down',
        moveLeft: isMac ? 'Alt+Left' : 'Ctrl+Left',
        moveRight: isMac ? 'Alt+Right' : 'Ctrl+Right',
        toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
        toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
        nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
        scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
        scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
        // 用方括号而非方向键：上下键已经用来滚动字幕，而 Ctrl+Alt+Up/Down 在 Windows 上被显卡驱动占用做屏幕旋转。
        detailPrev: isMac ? 'Cmd+Shift+[' : 'Ctrl+Shift+[',
        detailNext: isMac ? 'Cmd+Shift+]' : 'Ctrl+Shift+]',
        emergencyErase: isMac ? 'Cmd+Shift+E' : 'Ctrl+Shift+E',
        toggleTheme: isMac ? 'Cmd+Shift+L' : 'Ctrl+Shift+L',
        quit: isMac ? 'Cmd+Shift+Q' : 'Ctrl+Shift+Q',
    };
}

module.exports = { getDefaultKeybinds };
