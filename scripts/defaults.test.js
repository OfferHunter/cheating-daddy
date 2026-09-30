const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const defaults = require('../src/defaults');

test('saved values override defaults without losing false, zero or empty strings', () => {
    const saved = { screenshotThinking: false, detailThinking: true, micGateDwellMs: 0, customPrompt: '' };
    const merged = defaults.mergeDefaults(defaults.DEFAULT_PREFERENCES, saved);
    for (const [key, value] of Object.entries(saved)) assert.equal(merged[key], value);
    assert.equal(merged.theme, defaults.DEFAULT_PREFERENCES.theme);
    merged.theme = 'changed';
    assert.notEqual(defaults.DEFAULT_PREFERENCES.theme, 'changed');
});

test('missing and null values fall back to defaults', () => {
    assert.deepEqual(defaults.mergeDefaults(defaults.DEFAULT_PREFERENCES), defaults.DEFAULT_PREFERENCES);
    const merged = defaults.mergeDefaults(defaults.DEFAULT_PREFERENCES, { detailThinking: null, screenshotThinking: undefined });
    assert.equal(merged.detailThinking, defaults.DEFAULT_PREFERENCES.detailThinking);
    assert.equal(merged.screenshotThinking, defaults.DEFAULT_PREFERENCES.screenshotThinking);
});

test('restore defaults preserves user content and the existing layout reset policy', () => {
    const reset = defaults.getResetPreferences();
    for (const key of ['customPrompt', 'knowledgeDir', 'detailPaneWidth']) assert.equal(Object.hasOwn(reset, key), false);
    for (const [key, value] of Object.entries(reset)) assert.equal(value, defaults.DEFAULT_PREFERENCES[key]);
    assert.equal(reset.screenshotThinking, defaults.DEFAULT_PREFERENCES.screenshotThinking);
});

test('storage resolves partial saved configurations without writing to disk', () => {
    const saved = { screenshotThinking: false, detailThinking: true, micGateDwellMs: 0 };
    const context = {
        module: { exports: {} },
        console,
        require(name) {
            if (name === './defaults') return defaults;
            if (name === 'fs') return { existsSync: () => true, readFileSync: () => JSON.stringify(saved) };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/storage'), 'utf8'), context);
    const prefs = context.module.exports.getPreferences();
    assert.equal(prefs.screenshotThinking, false);
    assert.equal(prefs.detailThinking, true);
    assert.equal(prefs.micGateDwellMs, 0);
    assert.equal(prefs.theme, defaults.DEFAULT_PREFERENCES.theme);
    assert.equal(context.module.exports.getConfig().deepseekModel, defaults.DEFAULT_CONFIG.deepseekModel);
});
