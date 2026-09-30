const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const defaults = require('../src/defaults');
const { getDefaultKeybinds } = require('../src/utils/keybinds');

function loadHelp(language = 'zh') {
    const template = (strings, ...values) => strings.reduce((text, part, index) => text + part + flatten(values[index]), '');
    const flatten = value => Array.isArray(value) ? value.map(flatten).join('') : value == null ? '' : String(value);
    const context = {
        html: template,
        css: template,
        LocalizedLitElement: class {},
        t: (en, zh) => language === 'zh' ? zh : en,
        scrollbarStyles: '',
        unifiedPageStyles: '',
        customElements: { define() {} },
        window: { require: name => name === './defaults' ? defaults : { getDefaultKeybinds } },
    };
    const source = fs.readFileSync(require.resolve('../src/components/views/HelpView.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace('export class HelpView', 'class HelpView');
    vm.runInNewContext(source + '\nglobalThis.view = new HelpView(); globalThis.sections = guideSections();', context);
    return context;
}

test('help renders both languages with shared defaults and platform shortcuts', () => {
    for (const language of ['zh', 'en']) {
        const { view, sections } = loadHelp(language);
        const rendered = view.render();
        assert.equal(sections.length, 5);
        assert.ok(sections.every(section => section.items.length >= 2));
        assert.ok(rendered.includes(defaults.DEFAULT_CONFIG.deepseekModel));
        assert.ok(rendered.includes(getDefaultKeybinds().emergencyErase));
        assert.ok(rendered.includes('Windows 10'));
        assert.ok(rendered.includes('macOS'));
        assert.ok(rendered.includes('offer-hunter-config'));
        assert.ok(rendered.includes(language === 'zh' ? '帮助和支持' : 'Help & Support'));
    }
});

test('search filters answers, expands matches and explains empty results', () => {
    const { view } = loadHelp();
    view.query = 'Windows 10';
    let rendered = view.render();
    assert.ok(rendered.includes('Windows 10 麦克风权限'));
    assert.ok(!rendered.includes('如何准备知识库文件？'));
    assert.ok(rendered.includes('.open=true'));
    view.query = 'no-match-12345';
    rendered = view.render();
    assert.ok(rendered.includes('没有找到相关说明'));
    assert.ok(rendered.includes('官方资料与问题反馈'));
});

test('topic navigation clears search before scrolling to the section', async () => {
    const { view } = loadHelp();
    let target;
    view.query = 'Windows';
    view.updateComplete = Promise.resolve();
    view.renderRoot = { getElementById: id => ({ scrollIntoView: () => { target = id; } }) };
    view.jumpTo('data');
    await view.updateComplete;
    assert.equal(view.query, '');
    assert.equal(target, 'data');
});
