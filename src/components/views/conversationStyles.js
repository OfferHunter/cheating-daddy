import { css } from '../../assets/lit-core-2.7.4.min.js';

// 转录的外观（气泡 + 其中的 markdown），实时视图与历史页共用——历史页把录下来的会话显示成同一场对话，
// 而不是一串零件。颜色全取自主题 token，所以两个视图都自动跟随主题与两个透明度滑块。
export const conversationStyles = css`
    .message-row {
        display: flex;
    }

    .message-row.interviewer {
        justify-content: flex-start;
    }

    .message-row.assistant {
        justify-content: flex-end;
    }

    /* 上限压在 100% 以下：气泡得看得出是对话的一侧。真正决定长回答在哪换行的是这个值，不是 gutter。 */
    .message-body {
        max-width: 92%;
        padding: 8px 12px;
        border-radius: 10px;
        color: var(--text-primary);
        word-break: break-word;
        overflow-wrap: anywhere;
    }

    /* 两个说话人靠描边而不只是明暗区分：亮色主题下 --bg-surface 与 --bg-elevated 只差约 12 个色阶，几乎看不见。
       用 inset shadow 而非 border——后者会让每个气泡往外长 2px，除非影子根有 border-box 重置，而引入本文件的
       两个视图里有一个没有。 */
    .message-row.interviewer .message-body {
        background: var(--bg-surface);
        box-shadow: inset 0 0 0 1px var(--border);
        border-top-left-radius: 2px;
    }

    .message-row.assistant .message-body {
        background: var(--bg-elevated);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-strong) 55%, transparent);
        border-top-right-radius: 2px;
    }

    /* 面试者自己的发言和回答同侧，靠虚线、无填充区分，让视线仍然先落在回答上。虚线只能是真 border，
       所以这里要显式写 border-box。 */
    .message-row.user {
        justify-content: flex-end;
    }

    .message-row.user .message-body {
        background: transparent;
        border: 1px dashed var(--border-strong);
        box-sizing: border-box;
        border-top-right-radius: 2px;
        color: var(--text-secondary);
    }

    /* 多个回答会同时流式落地，各自带一个光标。挂在行上而不是正文上：正文是 markdown 直写节点，不能有子绑定。 */
    .message-row.assistant.streaming .message-body::after {
        content: '▍';
        margin-left: 1px;
        animation: caret-blink 1s step-end infinite;
    }

    @keyframes caret-blink {
        50% { opacity: 0; }
    }

    .message-body > :first-child {
        margin-top: 0;
    }

    .message-body > :last-child {
        margin-bottom: 0;
    }

    .message-body h1,
    .message-body h2,
    .message-body h3,
    .message-body h4,
    .message-body h5,
    .message-body h6 {
        margin: 1em 0 0.5em 0;
        color: inherit;
        font-weight: var(--font-weight-semibold);
    }

    .message-body h1 { font-size: 1.5em; }
    .message-body h2 { font-size: 1.3em; }
    .message-body h3 { font-size: 1.15em; }
    .message-body h4 { font-size: 1.05em; }
    .message-body h5,
    .message-body h6 { font-size: 1em; }

    .message-body p {
        margin: 0.6em 0;
        color: inherit;
    }

    .message-body ul,
    .message-body ol {
        margin: 0.6em 0;
        padding-left: 1.5em;
        color: inherit;
    }

    .message-body li {
        margin: 0.3em 0;
    }

    .message-body blockquote {
        margin: 0.8em 0;
        padding: 0.5em 1em;
        border-left: 2px solid var(--border-strong);
        background: var(--bg-hover);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    }

    .message-body code {
        background: var(--bg-hover);
        padding: 0.15em 0.4em;
        border-radius: var(--radius-sm);
        font-family: var(--font-mono);
        font-size: 0.85em;
    }

    .message-body pre {
        background: var(--bg-hover);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-md);
        overflow-x: auto;
        margin: 0.8em 0;
    }

    .message-body pre code {
        background: none;
        padding: 0;
    }

    .message-body a {
        color: var(--link-color);
        text-decoration: underline;
        text-underline-offset: 2px;
    }

    .message-body strong,
    .message-body b {
        font-weight: var(--font-weight-semibold);
    }

    .message-body hr {
        border: none;
        border-top: 1px solid var(--border);
        margin: 1.5em 0;
    }

    .message-body table {
        border-collapse: collapse;
        width: 100%;
        margin: 0.8em 0;
    }

    .message-body th,
    .message-body td {
        border: 1px solid var(--border);
        padding: var(--space-sm);
        text-align: left;
    }

    .message-body th {
        background: var(--bg-hover);
        font-weight: var(--font-weight-semibold);
    }
`;

// 三个视图（实时精简、实时详细、历史）都做同一件事：把 markdown 写进一个模板里已经存在的节点。它不能直接
// 写在模板里，否则每次渲染都要重解析。`memo` 存在节点自身上，调用方因此不用另建一张表；`key` 与渲染出的
// 文本分开，因为详细面板翻页时两个回答的正文可能一模一样，却必须重画。
export function syncMarkdownInto(el, key, content) {
    if (!el || el._renderedKey === key) return;
    el.innerHTML = renderMarkdown(content);
    el._renderedKey = key;
}

// 用户的背景资料和答案都是 markdown；`marked` 由 index.html 全局加载，这里不导入，解析器缺失时退化成原文而
// 不是空白气泡。
function renderMarkdown(content) {
    if (typeof window !== 'undefined' && window.marked) {
        try {
            window.marked.setOptions({
                breaks: true,
                gfm: true,
                sanitize: false,
            });
            return window.marked.parse(content);
        } catch (error) {
            console.warn('Error parsing markdown:', error);
            return content;
        }
    }
    return content;
}
