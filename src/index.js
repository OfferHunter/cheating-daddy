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
const storage = require('./storage');

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

    ipcMain.handle('open-external', async (event, url) => {
        try {
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
