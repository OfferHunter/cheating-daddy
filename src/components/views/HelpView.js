import { html, css } from '../../assets/lit-core-2.7.4.min.js';
import { LocalizedLitElement, t } from '../../utils/i18n.js';
import { scrollbarStyles, unifiedPageStyles } from './sharedPageStyles.js';

const { DEFAULT_CONFIG, DEFAULT_PREFERENCES } = window.require('./defaults');
const { getDefaultKeybinds } = window.require('./utils/keybinds');
const copy = (zh, en) => t(en, zh);

// Keep both interface languages together; technical defaults come from the shared configuration.
function guideSections() {
    return [
        { id: 'start', title: copy('开始使用', 'Getting started'), items: [
            [copy('首次使用需要准备什么？', 'What do I need to get started?'), copy('在主页配置两项服务：对话模型负责生成回答，阿里云百炼负责语音转录。分别填写各自的 API Key，并确认账户已开通服务且余额充足。安装版和解压即用版的配置方式相同。', 'Configure two services on Home: a chat model for answers and Alibaba Cloud Model Studio for transcription. Enter a separate API key for each and ensure both accounts have service access and sufficient balance. Installed and portable editions use the same setup.')],
            [copy('如何配置对话模型？', 'How do I configure the chat model?'), copy(`填写 Base URL、API Key 和准确的模型标识。默认地址为 ${DEFAULT_CONFIG.chatBaseUrl}，默认模型为 ${DEFAULT_CONFIG.deepseekModel}。也可使用其他 OpenAI 兼容服务，但必须同时匹配地址、密钥和模型。截图提问还要求模型支持图片输入。`, `Enter a Base URL, API key and exact model ID. Defaults: ${DEFAULT_CONFIG.chatBaseUrl}, model ${DEFAULT_CONFIG.deepseekModel}. Other OpenAI-compatible services are supported; the endpoint, key and model must match. Screen questions require image input support.`)],
            [copy('如何配置百炼语音识别？', 'How do I configure transcription?'), copy(`在百炼控制台开通服务并创建 API Key。默认模型为 ${DEFAULT_CONFIG.bailianModel}，地址为 ${DEFAULT_CONFIG.bailianWsUrl}。密钥、接入地址和模型需属于同一地域及匹配的业务空间；默认配置使用北京地域。`, `Enable Model Studio and create an API key. Default model: ${DEFAULT_CONFIG.bailianModel}. Endpoint: ${DEFAULT_CONFIG.bailianWsUrl}. The key, endpoint and model must use a matching region and workspace. The default configuration uses Beijing.`)],
            [copy('怎样开始第一场会话？', 'How do I start my first session?'), copy('可先在「AI 自定义」填写背景资料，然后在「设置」选择语音语言和麦克风。回到主页点击「开始会话」。先播放一段对方语音，确认能看到转录和回答，再测试自己的麦克风。自己的发言只补充上下文，不会触发回答。', 'Optionally add background information in AI Customization, then choose a speech language and microphone in Settings. Click Start Session on Home. Play some incoming speech to check transcription and answers, then test your microphone. Your own speech adds context and does not trigger answers.')],
            [copy('我想点击窗口背面的按钮怎么办？', 'What if I need to click a button behind the window?'), copy('可以利用鼠标穿透快捷键。设置里面可以改动，初始为 ctrl 加 m。打开之后，点击不会被应用窗口捕获，直接穿透到窗口背面的按键。', 'Use the click-through shortcut. You can change it in Settings; the default is Ctrl+M. While enabled, clicks are not captured by the app window and pass straight through to whatever is behind it.')],
            [copy('为什么我按快捷键没反应？', 'Why does my shortcut not respond?'), copy('有可能系统中其他应用占住了快捷键，在设置中更改未被占用的快捷键即可。以「截图」为例，点中右边的「Ctrl+Enter」，然后输入新的快捷键即可更改。', 'Another app on your system may be holding that shortcut. Change it in Settings to a combination that is not already in use. For example, for Screen capture, click the Ctrl+Enter field on the right and enter a new shortcut.')],
        ] },
        { id: 'audio', title: copy('音频与系统权限', 'Audio and permissions'), items: [
            [copy('对方声音和我的声音分别从哪里来？', 'Where do the two voices come from?'), copy('对方声音来自系统播放音频；Windows 下跟随系统默认播放设备。自己的声音来自设置中选择的麦克风，两路独立识别。选择「不使用麦克风」只关闭自己的声音采集，不影响系统音频。设置页的音量预览也会临时使用所选麦克风。', 'Incoming speech comes from system playback audio, using the default playback device on Windows. Your voice comes from the selected microphone and is transcribed separately. Disabling the microphone does not disable system audio. The Settings level preview also temporarily uses the selected microphone.')],
            [copy('语句静音时长和防串音门限怎么调？', 'How do I tune silence detection and the speaker gate?'), copy('语句静音时长决定停顿多久后结束一句，范围为 200–6000 ms。越短响应越快，也越容易拆句；自己的发言通常适合更长的停顿。扬声器门限用于减少扬声器声音被麦克风重复识别，在扬声器声音高于门限时关闭麦克风，-80 dBFS 基本等于关闭门限；门限保持时间越长，切换越稳定但越慢。', 'Silence detection controls how long a pause ends a sentence (200–6000 ms). Shorter pauses respond faster but split speech more often; your own speech generally benefits from longer pauses. The speaker gate reduces incoming audio leaking into microphone transcription; -80 dBFS effectively disables it. A longer gate dwell is steadier but slower. Start a new session after changing audio parameters.')],
            [copy('Windows 11 麦克风权限', 'Windows 11 microphone permission'), copy('打开「设置 → 隐私和安全性 → 麦克风」，开启「麦克风访问权限」及「允许桌面应用访问麦克风」。确认设备没有被物理静音，再重新启动应用。', 'Open Settings → Privacy & security → Microphone. Enable Microphone access and Let desktop apps access your microphone. Check the physical mute switch, then restart the app.')],
            [copy('Windows 10 麦克风权限', 'Windows 10 microphone permission'), copy('打开「设置 → 隐私 → 麦克风」，开启此设备的麦克风访问、允许应用访问麦克风，以及允许桌面应用访问麦克风。这类桌面应用通常不会弹出独立授权窗口。', 'Open Settings → Privacy → Microphone. Enable microphone access for this device, Allow apps to access your microphone, and Allow desktop apps to access your microphone. Desktop apps usually do not show an individual permission prompt.')],
            [copy('macOS 权限与兼容性', 'macOS permissions and compatibility'), copy('首次请求麦克风时选择允许。若之前拒绝，进入「系统设置 → 隐私与安全性 → 麦克风」开启；旧系统在「系统偏好设置 → 安全性与隐私 → 隐私」。截图及系统音频还可能需要屏幕录制或屏幕与系统音频录制权限。修改后退出并重开应用。当前版本主要按 Windows 流程验证，macOS 还取决于系统版本及音频辅助程序。', 'Allow microphone access when prompted. If denied, enable it in System Settings → Privacy & Security → Microphone (older macOS: System Preferences → Security & Privacy → Privacy). Screen capture and system audio may also require Screen Recording or Screen & System Audio Recording permission. Quit and reopen after changes. This release primarily targets Windows; macOS behavior also depends on the OS version and audio helper.')],
            [copy('有声音却没有转录，怎么办？', 'Why is there no transcript?'), copy('先区分是哪一路：对方声音检查会议软件输出是否与系统默认播放设备一致；自己的声音检查所选麦克风、系统权限及静音开关。再检查百炼密钥、余额、地域和网络。若对方说话时自己的转录停住，可能是防串音门限正在抑制麦克风；可戴耳机并在设置中调整门限。', 'Identify the affected stream first. For incoming audio, check that the meeting output matches the default playback device. For your voice, check the microphone selection, permissions and mute switch. Then check the transcription key, balance, region and network. The speaker gate can suppress your microphone while the other person speaks; try headphones and adjust the gate in Settings.')],
        ] },
        { id: 'answers', title: copy('回答、截图与上下文', 'Answers, screenshots and context'), items: [
            [copy('精要回答和详细回答有什么区别？', 'How do brief and detailed answers differ?'), copy('精要回答显示在转录区，便于快速扫读；详细回答在右侧面板，可按需读取知识库。拖动分隔线可调整宽度。关闭「显示详细回答侧栏」后，普通问题只生成精要回答，下一次会话生效。', 'Brief answers appear in the transcript for quick reading. Detailed answers appear in the side pane and can consult your knowledge base. Drag the divider to resize it. Disabling the detail pane disables detailed answers for ordinary questions from the next session.')],
            [copy('如何截图提问或输入文字？', 'How do I ask about a screenshot or type a question?'), copy('会话中点击「分析屏幕」或使用截图快捷键。模型必须支持图片输入；截图回答在详细面板展示，截图摘要加入历史。底部输入框按 Enter 可发送文字问题。同一快捷键在主页用于开始会话，在会话中用于截图。', 'Click Analyze Screen during a session or use its shortcut. The model must accept images. Screenshot answers appear in the detail pane, and a summary is added to history. Press Enter in the bottom input to send a text question. The screen shortcut starts a session when used on Home.')],
            [copy('为什么回答慢，或者长时间没有正文？', 'Why are answers slow or empty?'), copy(`先确认模型服务和网络可用。启用思考会增加首字等待时间，思考还会消耗输出预算。当前默认：精要思考${DEFAULT_PREFERENCES.briefThinking ? '开启' : '关闭'}，详细思考${DEFAULT_PREFERENCES.detailThinking ? '开启' : '关闭'}，截图思考${DEFAULT_PREFERENCES.screenshotThinking ? '开启' : '关闭'}。可关闭对应思考开关、减少上下文轮数，或提高过低的最大 Token 预算。回答开关通常下一次会话生效，最大 Token 数下一次请求生效。`, `Check the model service and network first. Reasoning delays the first visible word and consumes output tokens. Defaults: brief reasoning ${DEFAULT_PREFERENCES.briefThinking ? 'on' : 'off'}, detailed reasoning ${DEFAULT_PREFERENCES.detailThinking ? 'on' : 'off'}, screenshot reasoning ${DEFAULT_PREFERENCES.screenshotThinking ? 'on' : 'off'}. Disable reasoning, reduce context turns or increase an insufficient token budget. Answer switches generally apply next session; the token limit applies next request.`)],
            [copy('怎样调整语言、字体和透明度？', 'How do I adjust language, text and transparency?'), copy('设置中的界面语言支持中文和英文；语音语言影响识别，与界面语言独立。回答字号范围为 12–32 px。控件透明度影响面板和气泡，文字透明度独立控制文字；看不清时可提高两者。图像质量越高，截图文字越清楚，请求体也越大。', 'Settings offers Chinese and English interface languages; speech language separately guides transcription. Answer text ranges from 12–32 px. Component transparency affects panels and bubbles, while text transparency is independent. Increase opacity if content is hard to read. Higher image quality improves screenshot text clarity but increases request size.')],
            [copy('暂停、清除上下文和结束有什么区别？', 'How do pause, clear context and end differ?'), copy('暂停会暂停音频处理，恢复后仍在同一会话。清除上下文让模型不再引用清除前的轮次，不会删除本地历史。结束会话停止本次采集；已经识别出的麦克风末句也会保存。', 'Pause suspends audio processing and resumes within the same session. Clear context stops the model from replaying earlier turns without deleting local history. Ending stops capture; recognized microphone speech at the end is also saved.')],
            [copy('怎么开始笔试？', 'How do I start a written test?'), copy('笔试和面试都在会话中开始。笔试使用截图功能向 AI 提问即可。', 'Written tests and interviews both start within a session. For a written test, just use the screenshot feature to ask the AI.')],
        ] },
        { id: 'knowledge', title: copy('AI 自定义与知识库', 'AI customization and knowledge'), items: [
            [copy('简历和岗位要求放在哪里？', 'Where do I add my resume and job requirements?'), copy('在「AI 自定义」填写自定义指令，适合放精简的简历摘要、目标岗位、回答风格及限制条件。会话开始时加载这些内容；修改后请重新开始会话。较长的资料可以拆成知识库文件。', 'Use custom instructions in AI Customization for a concise resume summary, target role, answer style and constraints. These load at session start, so start a new session after editing. Put longer material into separate knowledge files.')],
            [copy('如何准备知识库文件？', 'How do I prepare knowledge files?'), copy('选择包含 Markdown（.md）文件的本地目录，每个文件是一条资料。文件开头使用 frontmatter 写 name 和 description，再写正文。模型先看名称和摘要，详细回答认为相关时才读取正文。原文件仍保留在你选择的目录。\n\n---\nname: 项目经历\ndescription: 主要项目、职责和技术成果\n---\n\n这里填写完整内容。', 'Choose a local folder of Markdown (.md) files, one entry per file. Add frontmatter with name and description, followed by the body. The model sees names and summaries first; detailed answers read relevant bodies on demand. Files stay in the selected folder.\n\n---\nname: Project experience\ndescription: Projects, responsibilities and results\n---\n\nWrite the full content here.')],
        ] },
        { id: 'data', title: copy('隐私与安全', 'Privacy And Safety'), items: [
            [copy('数据保存在什么位置？', 'Where is my data stored?'), copy('Windows：%APPDATA%\\offer-hunter-config\nmacOS：~/Library/Application Support/offer-hunter-config\nLinux：~/.config/offer-hunter-config\n\ncredentials.json 保存 API Key，preferences.json 保存偏好和自定义指令，history 文件夹保存会话。安装版和便携版在同一系统账户下共用这些数据；移动程序或重新安装通常不会清除它们。', 'Windows: %APPDATA%\\offer-hunter-config\nmacOS: ~/Library/Application Support/offer-hunter-config\nLinux: ~/.config/offer-hunter-config\n\ncredentials.json contains API keys, preferences.json contains preferences and instructions, and history contains sessions. Installed and portable editions share these files under the same OS account. Moving or reinstalling the app usually does not remove them.')],
            [copy('哪些内容会发送到外部服务？', 'What is sent to external services?'), copy('音频发送到百炼进行识别；转录、背景资料及相关知识库内容会按请求发送给配置的对话服务，截图提问还会发送屏幕图片。API Key 在本机以明文 JSON 保存，请勿把密钥或整个配置目录发给他人。我们（软件制作者）不会收集任何您的信息。', 'Audio is sent to Model Studio for transcription. Transcripts, background information and relevant knowledge content are sent to your configured chat service as needed; screen questions also send an image. Processing is not fully offline. API keys are stored locally as plain JSON; do not share keys or the whole configuration folder. Window capture protection depends on the OS and capture method and is not guaranteed in every screen-sharing scenario.')],
            [copy('这个软件的隐身是怎么做的？他绝对安全吗？', 'How does the app hide itself? Is it absolutely safe?'), copy('这个软件通过 Electron 的 SetWindowDisplayAffinity 实现隐身。它不会被绝大多数屏幕捕捉方式拍到，包括截图、录屏、腾讯会议等，但仍有一些底层技术可以绕过 Windows 控件显示保护获取原始屏幕画面，如 Windows Graphics Capture 和 GDI 中的 BitBlt。我们测试过牛客 AI 面试、腾讯会议、飞书会议等大多数面试软件均无法捕捉，但技术上实现绝对隐身是不可能的。', "The app uses Electron's SetWindowDisplayAffinity for screen-capture exclusion. It is not captured by the vast majority of screen-capture methods, including screenshots, screen recording, Tencent Meeting and similar tools. However, some technologies can bypass Windows display-affinity protection and read the raw screen, such as Windows Graphics Capture and BitBlt in GDI. We tested most interview apps — Nowcoder AI interview, Tencent Meeting, Feishu Meetings and others — and none captured it, but absolute invisibility is not technically achievable.")],
        ] },
    ];
}

export class HelpView extends LocalizedLitElement {
    static properties = { onExternalLinkClick: { type: Function }, query: { state: true } };
    static styles = [unifiedPageStyles, scrollbarStyles, css`
        .intro, .answer, .note { color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.7; }
        .intro { margin: 4px 0 12px; }
        .search { width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary); font: inherit; cursor: text; user-select: text; }
        .links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        button { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-size: var(--font-size-sm); }
        button:hover { background: var(--bg-hover); border-color: var(--accent); }
        button:focus-visible, summary:focus-visible, .search:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
        h2 { margin: 0 0 12px; }
        details { border-top: 1px solid var(--border); }
        summary { padding: 14px 0; color: var(--text-primary); cursor: pointer; font-size: var(--font-size-sm); line-height: 1.5; }
        .answer { margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); color: var(--text-secondary); }
        th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid var(--border); }
        th { color: var(--text-primary); }
        code { font-family: monospace; user-select: text; overflow-wrap: anywhere; }
        .note { margin: 12px 0 0; }
        section { scroll-margin-top: 16px; }
    `];

    constructor() {
        super();
        this.query = '';
        this.onExternalLinkClick = () => {};
    }

    jumpTo(id) {
        this.query = '';
        this.updateComplete.then(() => this.renderRoot.getElementById(id)?.scrollIntoView({ block: 'start' }));
    }

    render() {
        const query = this.query.trim().toLocaleLowerCase();
        const sections = guideSections();
        const filtered = sections.map(section => ({ ...section, items: section.items.filter(item => `${section.title} ${item.join(' ')}`.toLocaleLowerCase().includes(query)) })).filter(section => section.items.length);
        const keys = getDefaultKeybinds();
        const shortcuts = [
            ['screenShot', copy('开始会话 / 截图分析', 'Start session / analyze screen')],
            ['toggleVisibility', copy('显示 / 隐藏窗口', 'Show / hide window')],
            ['toggleClickThrough', copy('切换鼠标穿透', 'Toggle click-through')],
            ['moveUp', copy('向上移动窗口（其他方向同理）', 'Move window up (other arrows move in their directions)')],
            ['scrollUp', copy('向上滚动（向下使用 ↓）', 'Scroll up (use Down to scroll down)')],
            ['detailPrev', copy('上一条详细回答（下一条使用 ]）', 'Previous detailed answer (use ] for next)')],
            ['toggleTheme', copy('切换明暗主题', 'Toggle dark / light theme')],
            ['quit', copy('退出应用，保留数据', 'Quit and keep data')],
            ['emergencyErase', copy('紧急清除：隐藏、删除全部本地数据并退出', 'Emergency erase: hide, delete all local app data and quit')],
        ];
        return html`
            <div class="unified-page"><div class="unified-wrap">
                <header>
                    <h1 class="page-title">${copy('帮助和支持', 'Help & Support')}</h1>
                    <p class="intro">${copy('从首次配置到日常使用，在这里查找操作说明和常见问题。', 'Find setup instructions, everyday guidance and troubleshooting in one place.')}</p>
                    <input class="search" type="search" aria-label=${copy('搜索帮助', 'Search help')} placeholder=${copy('搜索：麦克风、API Key、截图、历史记录…', 'Search: microphone, API key, screenshots, history…')} .value=${this.query} @input=${event => { this.query = event.target.value; }} />
                    <nav class="links" aria-label=${copy('帮助目录', 'Help topics')}>
                        ${sections.map(section => html`<button @click=${() => this.jumpTo(section.id)}>${section.title}</button>`)}
                        <button @click=${() => this.jumpTo('shortcuts')}>${copy('快捷键', 'Shortcuts')}</button>
                        <button @click=${() => this.jumpTo('support')}>${copy('获取支持', 'Get support')}</button>
                    </nav>
                </header>
                ${query && !filtered.length ? html`<p class="note" role="status">${copy('没有找到相关说明，请尝试更短的关键词或通过下方渠道反馈。', 'No matching guidance. Try a shorter keyword or use the support information below.')}</p>` : ''}
                ${filtered.map(section => html`<section class="surface" id=${section.id}>
                    <h2 class="surface-title">${section.title}</h2>
                    ${section.items.map(([question, answer]) => html`<details .open=${Boolean(query)}><summary>${question}</summary><p class="answer">${answer}</p></details>`)}
                </section>`)}
                <section class="surface" id="shortcuts">
                    <h2 class="surface-title">${copy('本机默认快捷键', 'Default shortcuts for this platform')}</h2>
                    <p class="intro">${copy('可在设置中修改。下表是默认值；如已自定义，请以设置页为准。窗口无法点击时，可用鼠标穿透快捷键恢复交互。', 'Customize shortcuts in Settings. These are defaults; your saved settings take precedence. If the window cannot be clicked, toggle click-through to restore interaction.')}</p>
                    <div class="table-wrap"><table><thead><tr><th scope="col">${copy('操作', 'Action')}</th><th scope="col">${copy('快捷键', 'Shortcut')}</th></tr></thead><tbody>
                        ${shortcuts.map(([key, label]) => html`<tr><td>${label}</td><td><code>${keys[key]}</code></td></tr>`)}
                    </tbody></table></div>
                </section>
                <section class="surface" id="support">
                    <h2 class="surface-title">${copy('官方资料与问题反馈', 'Official resources and feedback')}</h2>
                    <div class="links">
                        ${[
                            ['DeepSeek API Keys', 'https://platform.deepseek.com/api_keys'],
                            [copy('DeepSeek 文档', 'DeepSeek documentation'), 'https://api-docs.deepseek.com/zh-cn/'],
                            [copy('百炼控制台', 'Model Studio console'), 'https://bailian.console.aliyun.com/'],
                            [copy('百炼 API Key 帮助', 'Model Studio API key guide'), 'https://help.aliyun.com/zh/model-studio/get-api-key/'],
                            ['二次开发前原仓库', 'https://github.com/sohzm/cheating-daddy'],
                        ].map(([label, url]) => html`<button @click=${() => this.onExternalLinkClick(url)}>${label}</button>`)}
                    </div>
                    <p class="note">${copy('如需反馈问题或提出需求，请联系提供软件的客服。请附上应用版本、系统版本、复现步骤、预期结果及实际现象；音频问题注明是对方声音还是自己的麦克风。截图请遮挡 API Key 和个人资料。当前尚未公布专用客服群入口。', 'For issues or feature requests, contact the support channel that supplied the app. Include app and OS versions, reproduction steps, expected behavior and what happened. For audio issues, specify incoming system audio or your microphone. Redact API keys and personal information in screenshots. No dedicated support-group link is published yet.')}</p>
                </section>
            </div></div>
        `;
    }
}

customElements.define('help-view', HelpView);
