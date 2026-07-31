if (require('electron-squirrel-startup')) {
    process.exit(0);
}

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { createWindow, updateGlobalShortcuts } = require('./utils/window');
const { setupGeminiIpcHandlers, stopMacOSAudioCapture, sendToRenderer } = require('./utils/gemini');
const { connectOpenAI, disconnectOpenAI, getOpenAIAuthStatus, ensureValidOpenAIAuth } = require('./utils/openaiOAuth');
const { listChatGptModels } = require('./utils/openaiModels');
const { summarizeSession } = require('./utils/sessionSummary');
const storage = require('./storage');

const geminiSessionRef = { current: null };
let mainWindow = null;

function createMainWindow() {
    mainWindow = createWindow(sendToRenderer, geminiSessionRef);
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
    setupGeminiIpcHandlers(geminiSessionRef);
    setupStorageIpcHandlers();
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
    require('./utils/localai').closeLocalSession();
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

    ipcMain.handle('storage:get-api-key', async () => {
        try {
            return { success: true, data: storage.getApiKey() };
        } catch (error) {
            console.error('Error getting API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-api-key', async (event, apiKey) => {
        try {
            storage.setApiKey(apiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-groq-api-key', async () => {
        try {
            return { success: true, data: storage.getGroqApiKey() };
        } catch (error) {
            console.error('Error getting Groq API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-groq-api-key', async (event, groqApiKey) => {
        try {
            storage.setGroqApiKey(groqApiKey);
            return { success: true };
        } catch (error) {
            console.error('Error setting Groq API key:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:get-openai-oauth', async () => {
        try {
            return { success: true, data: storage.getOpenaiOAuth() };
        } catch (error) {
            console.error('Error getting OpenAI OAuth data:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:set-openai-oauth', async (event, openaiOAuth) => {
        try {
            storage.setOpenaiOAuth(openaiOAuth);
            return { success: true };
        } catch (error) {
            console.error('Error setting OpenAI OAuth data:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:clear-openai-oauth', async () => {
        try {
            storage.clearOpenaiOAuth();
            return { success: true };
        } catch (error) {
            console.error('Error clearing OpenAI OAuth data:', error);
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

    // ============ LIMITS ============
    ipcMain.handle('storage:get-today-limits', async () => {
        try {
            return { success: true, data: storage.getTodayLimits() };
        } catch (error) {
            console.error('Error getting today limits:', error);
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

    ipcMain.handle('storage:export-backup', async () => {
        try {
            const result = await dialog.showSaveDialog(mainWindow || BrowserWindow.getFocusedWindow(), {
                title: 'Export Cheating Daddy Backup',
                defaultPath: 'cheating-daddy-backup.json',
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });

            if (result.canceled || !result.filePath) {
                return { success: false, canceled: true };
            }

            const fs = require('fs');
            fs.writeFileSync(result.filePath, JSON.stringify(storage.exportAllData(), null, 2), 'utf8');
            return { success: true, data: { filePath: result.filePath } };
        } catch (error) {
            console.error('Error exporting backup:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('storage:import-backup', async () => {
        try {
            const result = await dialog.showOpenDialog(mainWindow || BrowserWindow.getFocusedWindow(), {
                title: 'Import Cheating Daddy Backup',
                properties: ['openFile'],
                filters: [{ name: 'JSON Backup', extensions: ['json'] }],
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return { success: false, canceled: true };
            }

            const fs = require('fs');
            const filePath = result.filePaths[0];
            const raw = fs.readFileSync(filePath, 'utf8');
            const bundle = JSON.parse(raw);
            storage.importAllData(bundle);
            return { success: true, data: { filePath } };
        } catch (error) {
            console.error('Error importing backup:', error);
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

    ipcMain.handle('oauth:get-openai-status', async () => {
        try {
            await ensureValidOpenAIAuth();
        } catch (error) {
            console.warn('OpenAI auth refresh failed:', error.message);
        }
        return { success: true, data: getOpenAIAuthStatus() };
    });

    ipcMain.handle('oauth:connect-openai', async () => {
        try {
            const auth = await connectOpenAI({ existingAuth: storage.getOpenaiOAuth() });
            return { success: true, data: getOpenAIAuthStatus(), accountEmail: auth.accountEmail };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('oauth:disconnect-openai', async () => {
        await disconnectOpenAI();
        return { success: true, data: getOpenAIAuthStatus() };
    });

    // Токены не покидают main-процесс: рендерер получает только готовый список моделей
    ipcMain.handle('get-chatgpt-models', async () => {
        return await listChatGptModels();
    });

    // Имена от desktopCapturer бесполезны («Экран 1/2/3»), поэтому подмешиваем
    // человеческие label и геометрию из screen API, связывая их по display_id
    ipcMain.handle('get-screen-sources', async () => {
        try {
            const { desktopCapturer, screen } = require('electron');
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 320, height: 200 },
            });
            const displays = screen.getAllDisplays();
            const primaryId = screen.getPrimaryDisplay().id;

            const data = sources.map((source, index) => {
                const display = displays.find(d => String(d.id) === String(source.display_id));
                const thumbnail = source.thumbnail;
                const hasPreview = thumbnail && !thumbnail.isEmpty();
                return {
                    displayId: String(source.display_id ?? ''),
                    name: display?.label || source.name || `Экран ${index + 1}`,
                    isPrimary: display ? display.id === primaryId : false,
                    width: display?.bounds?.width ?? null,
                    height: display?.bounds?.height ?? null,
                    // Пустой thumbnail бывает у спящего монитора — превью просто не показываем
                    thumbnail: hasPreview ? thumbnail.toDataURL() : null,
                };
            });
            return { success: true, data };
        } catch (error) {
            console.error('Error listing screen sources:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('summarize-session', async (event, sessionId) => {
        const session = storage.getSession(sessionId);
        if (!session) {
            return { success: false, error: 'Сессия не найдена' };
        }
        // Готовый разбор возвращаем сразу — модель дважды звать незачем
        if (session.summary) {
            return { success: true, summary: session.summary, cached: true };
        }

        const result = await summarizeSession(session);
        if (result.success) {
            storage.saveSession(sessionId, { summary: result.summary, summaryCreatedAt: Date.now() });
        }
        return result;
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (mainWindow) {
            // Also save to storage
            storage.setKeybinds(newKeybinds);
            updateGlobalShortcuts(newKeybinds, mainWindow, sendToRenderer, geminiSessionRef);
        }
    });

    // Debug logging from renderer
    ipcMain.on('log-message', (event, msg) => {
        console.log(msg);
    });
}
