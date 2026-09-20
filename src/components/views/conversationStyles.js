import { css } from '../../assets/lit-core-2.7.4.min.js';

// The transcript's own look — bubbles and the markdown inside them — shared by the live view and the
// History page, which shows a recorded session as the same conversation rather than as a list of parts.
// Every colour resolves from a theme token, so both views follow the theme and the two alpha sliders.
export const conversationStyles = css`
    /* ── Bubbles ── */

    .message-row {
        display: flex;
    }

    .message-row.interviewer {
        justify-content: flex-start;
    }

    .message-row.assistant {
        justify-content: flex-end;
    }

    /* Well above the 78% this used to be: that cap, not the gutter, is what decided where an answer
       wrapped, and a long answer reached the cap on almost every line. Kept under 100% so a bubble
       still reads as one side of a conversation. */
    .message-body {
        max-width: 92%;
        padding: 8px 12px;
        border-radius: 10px;
        color: var(--text-primary);
        word-break: break-word;
        overflow-wrap: anywhere;
    }

    /* The two speakers are told apart by outline, not just by a lightness step: in light themes
       --bg-surface and --bg-elevated are ~12 units apart, which is nearly invisible. The answer
       gets the theme accent as a soft ring; --border-strong is opaque, hence the color-mix.
       Inset shadow rather than border: a real border would grow every bubble by 2px unless the
       shadow root has a border-box reset, and one of the two views importing this does not. */
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

    /* The candidate's own speech sits on the answers' side, told apart by a dashed outline and no
       fill, so the eye still lands on the answer. Only a real border can be dashed, hence the
       explicit border-box. */
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

    /* Several answers can stream at once, so each shows its own caret until it settles.
       Bound to the row: the markdown body has no child bindings and must stay untouched. */
    .message-row.assistant.streaming .message-body::after {
        content: '▍';
        margin-left: 1px;
        animation: caret-blink 1s step-end infinite;
    }

    @keyframes caret-blink {
        50% { opacity: 0; }
    }

    /* ── Markdown (all colours resolve from theme tokens, so every theme and both alpha
       sliders apply here without extra rules) ── */

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

// Answers are written by the model as markdown, and both views render it the same way. `marked` is
// loaded globally by index.html, so nothing is imported here and a missing parser degrades to the
// raw text rather than to an empty bubble.
export function renderMarkdown(content) {
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
