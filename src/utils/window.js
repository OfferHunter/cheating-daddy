const { BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('node:path');
const storage = require('../storage');
const { getDefaultKeybinds } = require('./keybinds');

let mouseEventsIgnored = false;
// 最近一次生效的键位表。设置页录制键位时会临时摘掉所有全局快捷键，失焦后要按这份表原样恢复。
let currentKeybinds = null;

const DEFAULT_MAIN_WINDOW_SIZE = { width: 1100, height: 800 };
const MIN_WINDOW_SIZE = { width: 700, height: 320 };

function createWindow(sendToRenderer) {
    let windowWidth = DEFAULT_MAIN_WINDOW_SIZE.width;
    let windowHeight = DEFAULT_MAIN_WINDOW_SIZE.height;

    const mainWindow = new BrowserWindow({
        icon: path.join(__dirname, '../assets', process.platform === 'win32' ? 'logo.ico' : 'logo.png'),
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

    const { session, desktopCapturer } = require('electron');
    session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
            desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
                callback({ video: sources[0], audio: 'loopback' });
            });
        },
        { useSystemPicker: true }
    );

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

    setupWindowIpcHandlers(mainWindow, sendToRenderer);

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
                console.log('Next step shortcut triggered');
                try {
                    const isMac = process.platform === 'darwin';
                    const shortcutKey = isMac ? 'cmd+enter' : 'ctrl+enter';

                    mainWindow.webContents.executeJavaScript(`
                        offerHunter.handleShortcut('${shortcutKey}');
                    `);
                } catch (error) {
                    console.error('Error handling next step shortcut:', error);
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

function setupWindowIpcHandlers(mainWindow, sendToRenderer) {
    ipcMain.on('view-changed', (event, view) => {
        if (!mainWindow.isDestroyed()) {
            const isLiveMode = view === 'assistant';

            if (process.platform !== 'win32') {
                mainWindow.setAlwaysOnTop(isLiveMode);
                mainWindow.setVisibleOnAllWorkspaces(isLiveMode, { visibleOnFullScreen: isLiveMode });
            }

            if (!isLiveMode) {
                mainWindow.setIgnoreMouseEvents(false);
            }
        }
    });

    ipcMain.handle('window-minimize', () => {
        if (!mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (!mainWindow.isDestroyed()) {
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer);
        }
    });

    // 设置页录制键位期间必须把全局快捷键全部摘掉：走 RegisterHotKey 的键在系统层就被吃掉，渲染进程收不到
    // keydown，于是任何"当前已注册"的组合（默认的 Ctrl+Up/Ctrl+Down 等）都无法录进输入框。失焦时再恢复。
    ipcMain.on('suspend-global-shortcuts', () => {
        globalShortcut.unregisterAll();
    });

    ipcMain.on('resume-global-shortcuts', () => {
        if (!mainWindow.isDestroyed() && currentKeybinds) {
            updateGlobalShortcuts(currentKeybinds, mainWindow, sendToRenderer);
        }
    });

    ipcMain.handle('toggle-window-visibility', async event => {
        try {
            if (mainWindow.isDestroyed()) {
                return { success: false, error: 'Window has been destroyed' };
            }

            if (mainWindow.isVisible()) {
                mainWindow.hide();
            } else {
                mainWindow.showInactive();
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
    setupWindowIpcHandlers,
};
