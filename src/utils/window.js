const { BrowserWindow, globalShortcut, ipcMain, screen, session, desktopCapturer } = require('electron');
const path = require('node:path');
const storage = require('../storage');
const { getDefaultKeybinds } = require('./keybinds');

let mouseEventsIgnored = false;
// 最近一次生效的键位表。设置页录制键位时会临时摘掉所有全局快捷键，失焦后要按这份表原样恢复。
let currentKeybinds = null;

// IPC 处理器只允许注册一次，而窗口可以重建（macOS 的 activate 会再建一个），所以处理器不留窗口引用，
// 统一读这里的「当前窗口」。重建窗口时由 createWindow 覆盖它们。
let currentWindow = null;
let sendToRendererRef = null;
let windowIpcWired = false;

const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 800 };
const MIN_WINDOW_SIZE = { width: 700, height: 320 };

// 每个 getDisplayMedia（桌面回环音）请求都要给它挑一块屏。desktopCapturer.getSources 是同步慢调用，实测会把
// 主进程事件循环卡住 235~771ms（进程内首调更久，可到 ~1.9s）——这段时间窗口收不到消息，表现为「进设置页卡一下，
// 像在同步等音频连上」。本应用永远只用唯一那块屏（sources[0]），所以枚举一次后缓存复用：命中缓存时
// getDisplayMedia 从 ~1.2s 降到 ~0.2s，且主进程不再被卡。启动时预热一次，把首次枚举的代价挪到尚无交互的启动阶段。
let cachedScreenSource = null;
let screenSourcePending = null;
let screenSourceWired = false;

function getScreenSource() {
    if (cachedScreenSource) return Promise.resolve(cachedScreenSource);
    if (!screenSourcePending) {
        screenSourcePending = desktopCapturer
            .getSources({ types: ['screen'] })
            .then(sources => (cachedScreenSource = sources[0]))
            .finally(() => (screenSourcePending = null));
    }
    return screenSourcePending;
}

function createWindow(sendToRenderer) {
    let windowWidth = DEFAULT_MAIN_WINDOW_SIZE.width;
    let windowHeight = DEFAULT_MAIN_WINDOW_SIZE.height;

    const mainWindow = new BrowserWindow({
        icon: path.join(__dirname, '../assets', process.platform === 'win32' ? 'logo.ico' : 'logo.png'),
        // win32 下 type:'toolbar' 会让窗口带上 WS_EX_TOOLWINDOW，从而从 Alt-Tab / Win+Tab 里消失。
        // setSkipTaskbar 只删任务栏按钮（ITaskbarList），Alt-Tab 是自己枚举窗口，不受它约束，所以两者要一起用。
        // 这是 Windows 专属取值，别的平台不传（实测 ExStyle 由 0x100 变 0x180）。
        ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
        width: windowWidth,
        height: windowHeight,
        minWidth: MIN_WINDOW_SIZE.width,
        minHeight: MIN_WINDOW_SIZE.height,
        resizable: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        alwaysOnTop: process.platform === 'win32',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // TODO: change to true
            backgroundThrottling: false,
            enableBlinkFeatures: 'GetDisplayMedia',
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#00000000',
    });

    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            // 每次请求都必须回一次 callback：拿到源就授予，枚举失败或没拿到屏就回空对象把请求拒掉。
            // 少了这条错误分支，getSources 一旦 reject，渲染端的 getDisplayMedia 会永远挂着。
            getScreenSource()
                .then(source => callback(source ? { video: source, audio: 'loopback' } : {}))
                .catch(error => {
                    console.error('Failed to resolve screen source for display media:', error);
                    callback({});
                });
        },
        { useSystemPicker: true }
    );

    // 只在首次建窗时预热并挂显示器事件：显示器的增/减会让缓存源的 id 失效（源 id 与屏幕绑定），这时清空缓存，
    // 下次请求重新枚举一次。'activate' 重建窗口不走这里，避免重复挂监听。
    if (!screenSourceWired) {
        screenSourceWired = true;
        ['display-added', 'display-removed', 'display-metrics-changed'].forEach(event =>
            screen.on(event, () => (cachedScreenSource = null))
        );
        getScreenSource();
    }

    mainWindow.setContentProtection(true);
    if (process.platform === 'win32') {
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }

    if (process.platform === 'win32') {
        try {
            mainWindow.setSkipTaskbar(true);
        } catch (error) {
            console.warn('Could not hide from taskbar:', error.message);
        }
    }

    if (process.platform === 'darwin') {
        try {
            mainWindow.setHiddenInMissionControl(true);
        } catch (error) {
            console.warn('Could not hide from Mission Control:', error.message);
        }
    }

    mainWindow.loadFile(path.join(__dirname, '../index.html'));

    mainWindow.webContents.once('dom-ready', () => {
        setTimeout(() => {
            const defaultKeybinds = getDefaultKeybinds();
            let keybinds = defaultKeybinds;

            const savedKeybinds = storage.getKeybinds();
            if (savedKeybinds) {
                keybinds = { ...defaultKeybinds, ...savedKeybinds };
            }

            updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer);
        }, 150);
    });

    // 这个窗口成为「当前窗口」，IPC 处理器读它。处理器只挂一次（见 wireWindowIpc），重建窗口时这里
    // 更新引用即可，不会再重复注册。
    currentWindow = mainWindow;
    sendToRendererRef = sendToRenderer;
    mainWindow.on('closed', () => {
        if (currentWindow === mainWindow) currentWindow = null;
    });
    wireWindowIpc();

    return mainWindow;
}

function updateGlobalShortcuts(keybinds, mainWindow, sendToRenderer) {
    // 必须与默认表合并，不能直接信传入的：设置页存的是用户改过的那几项，缺键不是中性的——下面每处注册都被
    // `if (keybinds.X)` 守着，缺的那个会静默地永不注册。
    keybinds = { ...getDefaultKeybinds(), ...(keybinds || {}) };
    currentKeybinds = keybinds;

    console.log('Updating global shortcuts with:', keybinds);

    globalShortcut.unregisterAll();

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const moveIncrement = Math.floor(Math.min(width, height) * 0.1);

    const movementActions = {
        moveUp: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY - moveIncrement);
        },
        moveDown: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX, currentY + moveIncrement);
        },
        moveLeft: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX - moveIncrement, currentY);
        },
        moveRight: () => {
            if (!mainWindow.isVisible()) return;
            const [currentX, currentY] = mainWindow.getPosition();
            mainWindow.setPosition(currentX + moveIncrement, currentY);
        },
    };

    Object.keys(movementActions).forEach(action => {
        const keybind = keybinds[action];
        if (keybind) {
            try {
                globalShortcut.register(keybind, movementActions[action]);
                console.log(`Registered ${action}: ${keybind}`);
            } catch (error) {
                console.error(`Failed to register ${action} (${keybind}):`, error);
            }
        }
    });

    if (keybinds.toggleVisibility) {
        try {
            globalShortcut.register(keybinds.toggleVisibility, () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.showInactive();
                }
            });
            console.log(`Registered toggleVisibility: ${keybinds.toggleVisibility}`);
        } catch (error) {
            console.error(`Failed to register toggleVisibility (${keybinds.toggleVisibility}):`, error);
        }
    }

    if (keybinds.toggleClickThrough) {
        try {
            globalShortcut.register(keybinds.toggleClickThrough, () => {
                mouseEventsIgnored = !mouseEventsIgnored;
                if (mouseEventsIgnored) {
                    mainWindow.setIgnoreMouseEvents(true, { forward: true });
                    console.log('Mouse events ignored');
                } else {
                    mainWindow.setIgnoreMouseEvents(false);
                    console.log('Mouse events enabled');
                }
                mainWindow.webContents.send('click-through-toggled', mouseEventsIgnored);
            });
            console.log(`Registered toggleClickThrough: ${keybinds.toggleClickThrough}`);
        } catch (error) {
            console.error(`Failed to register toggleClickThrough (${keybinds.toggleClickThrough}):`, error);
        }
    }

    if (keybinds.screenShot) {
        try {
            globalShortcut.register(keybinds.screenShot, async () => {
                console.log('Screenshot shortcut triggered');
                try {
                    const isMac = process.platform === 'darwin';
                    const shortcutKey = isMac ? 'cmd+enter' : 'ctrl+enter';

                    // 必须 await：executeJavaScript 返回 promise，不接住它时下面这个 try/catch 根本拦不到
                    // 渲染端抛出的错误，它会变成一个没人处理的 rejection。
                    await mainWindow.webContents.executeJavaScript(`
                        offerHunter.handleShortcut('${shortcutKey}');
                    `);
                } catch (error) {
                    console.error('Error handling screenshot shortcut:', error);
                }
            });
            console.log(`Registered screenShot: ${keybinds.screenShot}`);
        } catch (error) {
            console.error(`Failed to register screenShot (${keybinds.screenShot}):`, error);
        }
    }

    if (keybinds.scrollUp) {
        try {
            globalShortcut.register(keybinds.scrollUp, () => {
                console.log('Scroll up shortcut triggered');
                sendToRenderer('scroll-response-up');
            });
            console.log(`Registered scrollUp: ${keybinds.scrollUp}`);
        } catch (error) {
            console.error(`Failed to register scrollUp (${keybinds.scrollUp}):`, error);
        }
    }

    if (keybinds.scrollDown) {
        try {
            globalShortcut.register(keybinds.scrollDown, () => {
                console.log('Scroll down shortcut triggered');
                sendToRenderer('scroll-response-down');
            });
            console.log(`Registered scrollDown: ${keybinds.scrollDown}`);
        } catch (error) {
            console.error(`Failed to register scrollDown (${keybinds.scrollDown}):`, error);
        }
    }

    // 详细回答的翻页快捷键只是加速器：面板自己的 ‹ › 按钮才是入口，所以系统不肯让出这个键也无损失。
    if (keybinds.detailPrev) {
        try {
            globalShortcut.register(keybinds.detailPrev, () => {
                sendToRenderer('detail-prev');
            });
            console.log(`Registered detailPrev: ${keybinds.detailPrev}`);
        } catch (error) {
            console.error(`Failed to register detailPrev (${keybinds.detailPrev}):`, error);
        }
    }

    if (keybinds.detailNext) {
        try {
            globalShortcut.register(keybinds.detailNext, () => {
                sendToRenderer('detail-next');
            });
            console.log(`Registered detailNext: ${keybinds.detailNext}`);
        } catch (error) {
            console.error(`Failed to register detailNext (${keybinds.detailNext}):`, error);
        }
    }

    if (keybinds.emergencyErase) {
        try {
            globalShortcut.register(keybinds.emergencyErase, () => {
                console.log('Emergency Erase triggered!');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.hide();

                    sendToRenderer('clear-sensitive-data');

                    setTimeout(() => {
                        const { app } = require('electron');
                        app.quit();
                    }, 300);
                }
            });
            console.log(`Registered emergencyErase: ${keybinds.emergencyErase}`);
        } catch (error) {
            console.error(`Failed to register emergencyErase (${keybinds.emergencyErase}):`, error);
        }
    }

    if (keybinds.toggleTheme) {
        try {
            globalShortcut.register(keybinds.toggleTheme, async () => {
                console.log('Toggle theme shortcut triggered');
                try {
                    await mainWindow.webContents.executeJavaScript(`
                        offerHunter.theme.togglePolarity();
                    `);
                } catch (error) {
                    console.error('Error toggling theme:', error);
                }
            });
            console.log(`Registered toggleTheme: ${keybinds.toggleTheme}`);
        } catch (error) {
            console.error(`Failed to register toggleTheme (${keybinds.toggleTheme}):`, error);
        }
    }

    // 与 emergencyErase 不同，这里是普通退出，不动数据。
    if (keybinds.quit) {
        try {
            globalShortcut.register(keybinds.quit, () => {
                console.log('Quit shortcut triggered');
                // index.js 的 before-quit 会停掉音频采集并关闭会话。
                const { app } = require('electron');
                app.quit();
            });
            console.log(`Registered quit: ${keybinds.quit}`);
        } catch (error) {
            console.error(`Failed to register quit (${keybinds.quit}):`, error);
        }
    }
}

// 只挂一次：这些是 ipcMain 级别的处理器，第二次注册同名 handler 会抛错，而窗口可以重建。处理器因此不
// 闭包某个窗口，一律读 currentWindow。
function wireWindowIpc() {
    if (windowIpcWired) return;
    windowIpcWired = true;

    ipcMain.on('view-changed', (event, view) => {
        const win = currentWindow;
        if (!win || win.isDestroyed()) return;

        const isLiveMode = view === 'assistant';

        if (process.platform !== 'win32') {
            win.setAlwaysOnTop(isLiveMode);
            win.setVisibleOnAllWorkspaces(isLiveMode, { visibleOnFullScreen: isLiveMode });
        }

        // 离开实时视图时点击穿透要关掉，标志位必须跟着复位：只关窗口不改标志，下一次按切换键会读到过期的
        // true 而把状态翻反，得多按一次才生效。顺带把复位告诉渲染端，免得它的镜像状态也过期。
        if (!isLiveMode) {
            win.setIgnoreMouseEvents(false);
            if (mouseEventsIgnored) {
                mouseEventsIgnored = false;
                win.webContents.send('click-through-toggled', false);
            }
        }

        // 实时视图叠在视频/会议窗上：点面板上的按钮不该把焦点从背后窗口夺走。Win 下 setFocusable(false)
        // 即 WS_EX_NOACTIVATE——窗口不再被激活，但鼠标点击照旧可达（按钮、拖拽、滚轮都正常），于是背后
        // 窗口保持焦点。代价是实时视图收不到键盘输入：Type a message 输入框打不了字（快捷键全是
        // globalShortcut，不受影响）。默认开启，但部分网站/会议软件会检测窗口聚焦率，所以留了
        // nonFocusableSession 偏好可关（关掉后实时视图恢复可聚焦）。其它视图必须保持可聚焦，否则激活页
        // 的激活码、设置页的 API Key 等输入框都打不了字。setFocusable 只支持 Win/macOS。
        if (process.platform !== 'linux') {
            const nonFocusable = storage.getPreferences().nonFocusableSession !== false;
            win.setFocusable(!(isLiveMode && nonFocusable));
        }
    });

    ipcMain.handle('window-minimize', () => {
        const win = currentWindow;
        if (win && !win.isDestroyed()) {
            win.minimize();
        }
    });

    // update-keybinds 不在这里挂：index.js 已经处理它（存盘 + 更新快捷键），这里再挂一份会让每次改键位
    // 都跑两遍 unregisterAll + 全量重注册。

    // 设置页录制键位期间必须把全局快捷键全部摘掉：走 RegisterHotKey 的键在系统层就被吃掉，渲染进程收不到
    // keydown，于是任何"当前已注册"的组合（默认的 Ctrl+Up/Ctrl+Down 等）都无法录进输入框。失焦时再恢复。
    ipcMain.on('suspend-global-shortcuts', () => {
        globalShortcut.unregisterAll();
    });

    ipcMain.on('resume-global-shortcuts', () => {
        const win = currentWindow;
        if (win && !win.isDestroyed() && currentKeybinds) {
            updateGlobalShortcuts(currentKeybinds, win, sendToRendererRef);
        }
    });

    ipcMain.handle('toggle-window-visibility', async event => {
        try {
            const win = currentWindow;
            if (!win || win.isDestroyed()) {
                return { success: false, error: 'Window has been destroyed' };
            }

            if (win.isVisible()) {
                win.hide();
            } else {
                win.showInactive();
            }
            return { success: true };
        } catch (error) {
            console.error('Error toggling window visibility:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    createWindow,
    updateGlobalShortcuts,
};
