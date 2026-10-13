if (require('electron-squirrel-startup')) {
    process.exit(0);
}

// First, before anything can log: a GBK console renders our UTF-8 Chinese as mojibake.
require('./utils/consoleEncoding').enableUtf8Console();

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { createWindow, updateGlobalShortcuts } = require('./utils/window');
const { setupIpcHandlers, stopMacOSAudioCapture, sendToRenderer } = require('./utils/session');
const teleprompter = require('./utils/teleprompter');
const storage = require('./storage');

// 透明窗在 Windows 上 hide()/showInactive() 时，DWM 会先把上一次的透明合成表面贴一帧再收起重画，
// 表现为「先闪一下」（electron#10069，窗口不透明时不复现）。这里关掉窗口管理器动画，让这次显隐不带过渡帧。
// 必须在 app ready 之前 append；仅 Windows 相关。
if (process.platform === 'win32') {
    app.commandLine.appendSwitch('wm-window-animations-disabled');
}

// 隐蔽性：调试口能把渲染器整个接管——CDP 可以 Page.captureScreenshot 截图、Runtime.evaluate 读屏上文字，
// 且这条路不受 setContentProtection / WDA 约束（见 scripts/capture-test/）。所以在建窗口之前就拒掉带调试开关的
// 启动：不建窗口、不读存储、静默退出。主进程的 --inspect* 已由 forge 的 EnableNodeCliInspectArguments fuse 关掉，
// 这里连同 argv 一并兜住，覆盖 fuse 覆盖不到的 Chromium 开关（--remote-debugging-port 不受 fuse 约束）。
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'];
const debugRequested =
    DEBUG_SWITCHES.some(name => app.commandLine.hasSwitch(name)) ||
    process.argv.some(arg => /^--(inspect|inspect-brk|inspect-port|remote-debugging)/.test(arg));

if (debugRequested) {
    console.error('Refusing to start: a debug switch was passed; it would expose the renderer over CDP.');
    app.exit(1);
}

// 面试进行中，主进程任何未捕获异常都不许把进程带走：Electron 默认会弹「A JavaScript error occurred in
// the main process」并中断会话。注册自己的监听器即取代那个默认弹窗（Electron 按 listenerCount 判断是否
// 已有用户监听器），这里只记日志，让会话继续跑。unhandledRejection 同理，在 Electron 里默认也会终止进程。
process.on('uncaughtException', error => {
    console.error('[Main] Uncaught exception (kept alive):', error);
});

process.on('unhandledRejection', reason => {
    console.error('[Main] Unhandled rejection (kept alive):', reason);
});

let mainWindow = null;

function createMainWindow() {
    mainWindow = createWindow(sendToRenderer);
    return mainWindow;
}

app.whenReady().then(async () => {
    // Initialize storage (checks version, resets if needed)
    storage.initializeStorage();

    // Trigger screen recording permission prompt on macOS if not already granted
    if (process.platform === 'darwin') {
        const { desktopCapturer } = require('electron');
        desktopCapturer.getSources({ types: ['screen'] }).catch(() => {});
    }

    createMainWindow();
    setupIpcHandlers();
    setupStorageIpcHandlers();
    setupKnowledgeIpcHandlers();
    setupGeneralIpcHandlers();
    setupLicenseIpcHandlers();
    setupTeleprompterIpcHandlers();
    require('./utils/asrTest').setupAsrTestIpcHandlers();

    // 跟着 app 常驻,不随会话起停:面试前就能配对好、把手机页面开着。端口占用/防火墙提示都在这里发生。
    try {
        await teleprompter.startTeleprompter();
    } catch (error) {
        console.error('[Teleprompter] Failed to start:', error);
    }
});

app.on('window-all-closed', () => {
    stopMacOSAudioCapture();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopMacOSAudioCapture();
    require('./utils/pipeline').closeLocalSession();
    require('./utils/asrTest').stopAsrTest();
    teleprompter.stopTeleprompter();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

function setupStorageIpcHandlers() {
    // ============ CONFIG ============
    ipcMain.handle('storage:get-config', async () => {
        try {
            return { success: true, data: storage.getConfig() };
        } catch (error) {
            console.error('Error getting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-config', async (event, config) => {
        try {
            storage.setConfig(config);
            return { success: true };
        } catch (error) {
            console.error('Error setting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:update-config', async (event, key, value) => {
        try {
            storage.updateConfig(key, value);
            return { success: true };
        } catch (error) {
            console.error('Error updating config:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ CREDENTIALS ============
    ipcMain.handle('storage:get-credentials', async () => {
        try {
            return { success: true, data: storage.getCredentials() };
        } catch (error) {
            console.error('Error getting credentials:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-credentials', async (event, credentials) => {
        try {
            storage.setCredentials(credentials);
            return { success: true };
        } catch (error) {
            console.error('Error setting credentials:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-deepseek-api-key', async () => {
        try {
            return { success: true, data: storage.getDeepseekApiKey() };
        } catch (error) {
            console.error('Error getting DeepSeek API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-deepseek-api-key', async (event, deepseekApiKey) => {
        try {
            storage.setDeepseekApiKey(deepseekApiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting DeepSeek API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-bailian-api-key', async () => {
        try {
            return { success: true, data: storage.getBailianApiKey() };
        } catch (error) {
            console.error('Error getting Bailian API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-bailian-api-key', async (event, bailianApiKey) => {
        try {
            storage.setBailianApiKey(bailianApiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting Bailian API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-tencent-credentials', async () => {
        try {
            return { success: true, data: storage.getTencentCredentials() };
        } catch (error) {
            console.error('Error getting Tencent credentials:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-tencent-credentials', async (event, credentials) => {
        try {
            storage.setTencentCredentials(credentials);
            return { success: true };
        } catch (error) {
            console.error('Error setting Tencent credentials:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ PREFERENCES ============
    ipcMain.handle('storage:get-preferences', async () => {
        try {
            return { success: true, data: storage.getPreferences() };
        } catch (error) {
            console.error('Error getting preferences:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-preferences', async (event, preferences) => {
        try {
            storage.setPreferences(preferences);
            return { success: true };
        } catch (error) {
            console.error('Error setting preferences:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:update-preference', async (event, key, value) => {
        try {
            storage.updatePreference(key, value);
            return { success: true };
        } catch (error) {
            console.error('Error updating preference:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ KEYBINDS ============
    ipcMain.handle('storage:get-keybinds', async () => {
        try {
            return { success: true, data: storage.getKeybinds() };
        } catch (error) {
            console.error('Error getting keybinds:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-keybinds', async (event, keybinds) => {
        try {
            storage.setKeybinds(keybinds);
            return { success: true };
        } catch (error) {
            console.error('Error setting keybinds:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ HISTORY ============
    ipcMain.handle('storage:get-all-sessions', async () => {
        try {
            return { success: true, data: storage.getAllSessions() };
        } catch (error) {
            console.error('Error getting sessions:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-session', async (event, sessionId) => {
        try {
            return { success: true, data: storage.getSession(sessionId) };
        } catch (error) {
            console.error('Error getting session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:save-session', async (event, sessionId, data) => {
        try {
            storage.saveSession(sessionId, data);
            return { success: true };
        } catch (error) {
            console.error('Error saving session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:delete-session', async (event, sessionId) => {
        try {
            storage.deleteSession(sessionId);
            return { success: true };
        } catch (error) {
            console.error('Error deleting session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:delete-all-sessions', async () => {
        try {
            storage.deleteAllSessions();
            return { success: true };
        } catch (error) {
            console.error('Error deleting all sessions:', error);
            return { success: false, error: error.message };
        }
    });

    // The renderer names sessions to export; the paths stay here, like the knowledge directory. What is
    // written is the stored session verbatim, not the merged timeline the page shows: an export that
    // re-derived its shape would quietly drop fields the reader never sees.
    ipcMain.handle('storage:export-sessions', async (event, sessionIds) => {
        try {
            const ids = Array.isArray(sessionIds) ? sessionIds : [];
            const sessions = ids.map(id => storage.getSession(String(id))).filter(Boolean);
            if (!sessions.length) {
                return { success: false, error: 'No sessions to export' };
            }

            // One session gets a file picker so it can be renamed; several get a folder and keep their
            // own <sessionId>.json names, because a single merged document would lose that per-session
            // shape and make the files no longer drop-in replacements for the ones in the config dir.
            if (sessions.length === 1) {
                const result = await dialog.showSaveDialog(mainWindow, {
                    title: '导出会话',
                    defaultPath: `session-${sessions[0].sessionId}.json`,
                    filters: [{ name: 'JSON', extensions: ['json'] }],
                });
                if (result.canceled || !result.filePath) {
                    return { success: false, canceled: true };
                }
                fs.writeFileSync(result.filePath, JSON.stringify(sessions[0], null, 2), 'utf8');
                return { success: true, count: 1, dir: path.dirname(result.filePath) };
            }

            const result = await dialog.showOpenDialog(mainWindow, {
                title: '选择导出目录',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || !result.filePaths.length) {
                return { success: false, canceled: true };
            }

            const dir = result.filePaths[0];
            sessions.forEach(session => {
                fs.writeFileSync(path.join(dir, `${session.sessionId}.json`), JSON.stringify(session, null, 2), 'utf8');
            });
            return { success: true, count: sessions.length, dir };
        } catch (error) {
            console.error('Error exporting sessions:', error);
            return { success: false, error: error.message };
        }
    });

    // ============ CLEAR ALL ============
    ipcMain.handle('storage:clear-all', async () => {
        try {
            storage.clearAllData();
            return { success: true };
        } catch (error) {
            console.error('Error clearing all data:', error);
            return { success: false, error: error.message };
        }
    });
}

// The knowledge directory is the user's own folder, so every path decision stays here: the renderer
// names an entry by id and never sees or sends a path.
function setupKnowledgeIpcHandlers() {
    const knowledge = require('./utils/knowledge');

    // The folder picker lives in the main process because the renderer has no dialog module of its own,
    // and the result is saved here rather than handed back to be written: one round trip, and no state
    // that exists only in a view that is about to be torn down.
    ipcMain.handle('knowledge:choose-directory', async () => {
        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: '选择知识目录',
                properties: ['openDirectory'],
            });

            if (result.canceled || !result.filePaths.length) {
                return { success: false, canceled: true };
            }

            const dir = result.filePaths[0];
            storage.updatePreference('knowledgeDir', dir);
            return { success: true, dir };
        } catch (error) {
            console.error('Error choosing knowledge directory:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('knowledge:get-list', async () => {
        try {
            const dir = storage.getPreferences().knowledgeDir || '';
            const entries = knowledge.listKnowledgeEntries(dir).map(({ id, name, description }) => ({ id, name, description }));
            return { success: true, dir, entries };
        } catch (error) {
            console.error('Error listing knowledge entries:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('knowledge:preview', async (event, id) => {
        try {
            const dir = storage.getPreferences().knowledgeDir || '';
            const entry = knowledge.readKnowledgeById(dir, id);

            return entry.ok
                ? { success: true, name: entry.name, description: entry.description, body: entry.body }
                : { success: false, error: entry.error };
        } catch (error) {
            console.error('Error reading knowledge entry:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('knowledge:clear-directory', async () => {
        try {
            storage.updatePreference('knowledgeDir', '');
            return { success: true };
        } catch (error) {
            console.error('Error clearing knowledge directory:', error);
            return { success: false, error: error.message };
        }
    });

    // Deleting an entry would mean writing inside a directory the user owns, outside this app's config
    // dir. Showing the file in the file manager costs one line and leaves the folder the user's own.
    ipcMain.handle('knowledge:reveal', async (event, id) => {
        try {
            const dir = storage.getPreferences().knowledgeDir || '';
            const entry = knowledge.listKnowledgeEntries(dir).find(candidate => candidate.id === id);
            if (!entry) {
                return { success: false, error: '条目不存在' };
            }

            shell.showItemInFolder(path.join(dir, entry.file));
            return { success: true };
        } catch (error) {
            console.error('Error revealing knowledge entry:', error);
            return { success: false, error: error.message };
        }
    });
}

function setupGeneralIpcHandlers() {
    ipcMain.handle('get-app-version', async () => {
        return app.getVersion();
    });

    ipcMain.handle('quit-application', async event => {
        try {
            stopMacOSAudioCapture();
            app.quit();
            return { success: true };
        } catch (error) {
            console.error('Error quitting application:', error);
            return { success: false, error: error.message };
        }
    });

    // 渲染端的链接来自模型输出/回答里的 markdown，一律当不可信。shell.openExternal 会把 URL 原样交给系统
    // 处理器：一个 file:// 或 search-ms:/ms-msdt: 之类的自定义协议就可能在用户机器上打开文件或启动程序
    // （Electron 的经典开放重定向/RCE 面）。只放行 http(s)/mailto。
    ipcMain.handle('open-external', async (event, url) => {
        try {
            let scheme = '';
            try {
                scheme = new URL(String(url)).protocol;
            } catch {
                scheme = '';
            }
            if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'mailto:') {
                return { success: false, error: 'blocked scheme' };
            }
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            console.error('Error opening external URL:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (mainWindow) {
            // Also save to storage
            storage.setKeybinds(newKeybinds);
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer);
        }
    });

    // Debug logging from renderer
    ipcMain.on('log-message', (event, msg) => {
        console.log(msg);
    });
}

// 手机提词的服务状态:地址、配对码都只在渲染端展示,令牌本身不出主进程——配对码换令牌那一步在页面上完成。
function setupTeleprompterIpcHandlers() {
    ipcMain.handle('teleprompter:get-status', async () => {
        try {
            return { success: true, data: teleprompter.getStatus() };
        } catch (error) {
            console.error('Error reading teleprompter status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('teleprompter:regenerate-code', async () => {
        try {
            return { success: true, data: teleprompter.regenerateCode() };
        } catch (error) {
            console.error('Error regenerating teleprompter code:', error);
            return { success: false, error: error.message };
        }
    });

    // 渲染端换主题后把解析令牌推来,缓存进提词服务,供手机页的 /theme.css 取一次。
    ipcMain.on('teleprompter:theme', (event, tokens) => {
        teleprompter.setTheme(tokens);
    });

    // 手机下达的指令落到桌面:截图必须走渲染端(采集流在那里),清空上下文则复用桌面自己那套——同时清模型
    // 记忆和已落定气泡,不另写一份逻辑。没会话时两者都会自行拒绝,所以这里不做额外校验。
    teleprompter.setCommandHandler(action => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (action === 'screenshot') {
            win.webContents
                .executeJavaScript('window.captureManualScreenshot && window.captureManualScreenshot()', true)
                .catch(error => console.error('Teleprompter screenshot command failed:', error.message));
        } else if (action === 'clear-context') {
            win.webContents
                .executeJavaScript(
                    'window.offerHunter && window.offerHunter.element && window.offerHunter.element().handleClearContext()',
                    true
                )
                .catch(error => console.error('Teleprompter clear-context command failed:', error.message));
        }
    });
}

// 激活码的核验全在主进程：渲染端只拿到"是否已激活"和机器码，验签与私钥相关的一切都不出这里。
function setupLicenseIpcHandlers() {
    const license = require('./utils/license');

    ipcMain.handle('license:get-machine-code', async () => {
        try {
            return { success: true, data: license.getMachineCode() };
        } catch (error) {
            console.error('Error getting machine code:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('license:get-status', async () => {
        try {
            return { success: true, data: { activated: license.isActivated() } };
        } catch (error) {
            console.error('Error reading license status:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('license:activate', async (event, code) => {
        try {
            return license.activate(String(code ?? ''));
        } catch (error) {
            console.error('Error activating:', error);
            return { success: false, error: 'internal' };
        }
    });
}
