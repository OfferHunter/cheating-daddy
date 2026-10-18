// 权威的动作清单：注册处 (window.js)、设置页 (CustomizeView.js) 和帮助页 (HelpView.js) 都从这一份取值。
// 以前三处各抄一遍键名，改一个键名时只有一处会跟着改，别处静默指向不存在的键——注册处的 `if (keybinds.X)`
// 会守空，设置页会显示空白，帮助页会把 `keys[key]` 渲染成 undefined。`name` 是设置页的显示名；帮助页的
// 本地化短语是帮助页专属文案，在那边按 key 取用，不重复放在这里。
const KEYBIND_ACTIONS = [
    { key: 'moveUp', name: 'Move Window Up' },
    { key: 'moveDown', name: 'Move Window Down' },
    { key: 'moveLeft', name: 'Move Window Left' },
    { key: 'moveRight', name: 'Move Window Right' },
    { key: 'toggleVisibility', name: 'Toggle Visibility' },
    { key: 'toggleClickThrough', name: 'Toggle Click-through' },
    { key: 'screenShot', name: 'Take ScreenShot' },
    { key: 'screenShotToCache', name: 'Screenshot to cache' },
    { key: 'scrollUp', name: 'Scroll Response Up' },
    { key: 'scrollDown', name: 'Scroll Response Down' },
    { key: 'detailPrev', name: 'Previous Detailed Answer' },
    { key: 'detailNext', name: 'Next Detailed Answer' },
    { key: 'toggleTheme', name: 'Toggle Light/Dark Theme' },
    { key: 'emergencyErase', name: 'Emergency Erase' },
    { key: 'quit', name: 'Quit' },
];

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
        screenShot: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
        screenShotToCache: isMac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter',
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

function getKeybindActions() {
    return KEYBIND_ACTIONS.map(action => ({ ...action }));
}

module.exports = { getDefaultKeybinds, getKeybindActions };
