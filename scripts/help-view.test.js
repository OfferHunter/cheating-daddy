const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const defaults = require('../src/defaults');
// 用真实的 keybinds 模块而非手搭的桩：帮助页现在从这份共享表取动作清单，桩里少一个导出就会渲染失败。
const keybinds = require('../src/utils/keybinds');
const { getDefaultKeybinds } = keybinds;

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
        window: { require: name => (name === './defaults' ? defaults : keybinds) },
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
        const helpTitle = language === 'zh' ? '帮助和支持' : 'Help & Support';
        // 页面标题现在是激活提示，原帮助标题下沉到输入框之后。
        const activationTitle = language === 'zh' ? '产品激活' : 'Product activation';
        assert.ok(rendered.includes(activationTitle));
        assert.ok(rendered.indexOf(activationTitle) < rendered.indexOf(helpTitle));
        assert.ok(rendered.includes(language === 'zh' ? '输入新的激活码' : 'Enter a new activation code'));
    }
});

test('activation input submits trimmed code and reports failures inline', async () => {
    const context = loadHelp();
    const { view } = context;
    const submitted = [];
    const status = { activated: true, expiresAt: null };
    context.offerHunter = {
        license: {
            activate: async code => {
                submitted.push(code);
                return code === 'OH2.BAD' ? { success: false, error: 'machine' } : { success: true };
            },
            getStatus: async () => status,
        },
    };

    view._licenseInput = '  OH2-NEW-CODE  ';
    await view.activateLicense();
    assert.deepEqual(submitted, ['OH2-NEW-CODE']);
    assert.equal(view._licenseInput, '');
    assert.equal(view._licenseSuccess, true);
    assert.equal(view._licenseError, '');
    assert.deepEqual(view._activation, status);

    view._licenseInput = 'OH2.BAD';
    await view.activateLicense();
    assert.equal(view._licenseSuccess, false);
    assert.equal(view._licenseError, '该激活码属于其他电脑。');
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
