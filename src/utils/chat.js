const { getConfig, getDeepseekApiKey } = require('../storage');

const DEFAULT_CHAT_BASE_URL = 'https://api.deepseek.com';
const CHAT_MAX_TOKENS = 8192;
// Covers the whole streamed response, not just the headers. Without it a stalled stream would
// leave the caller's in-flight guard latched forever and silently eat every later turn.
const CHAT_TIMEOUT_MS = 120000;

function getChatBaseUrl() {
    const configured = (getConfig().chatBaseUrl || '').trim();
    return configured ? configured.replace(/\/+$/, '') : DEFAULT_CHAT_BASE_URL;
}

function getChatModel() {
    return getConfig().deepseekModel || 'deepseek-flash';
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let token = '';
            try {
                // Thinking models emit delta.reasoning_content first; only the final answer is shown.
                token = JSON.parse(data).choices?.[0]?.delta?.content || '';
            } catch {
                continue;
            }

            if (!token) continue;

            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

async function requestChat(messages, onText) {
    const apiKey = getDeepseekApiKey();
    if (!apiKey || !apiKey.trim()) {
        throw new Error('No chat API key configured');
    }

    const response = await fetch(`${getChatBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: getChatModel(),
            messages,
            stream: true,
            max_tokens: CHAT_MAX_TOKENS,
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Chat API returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
    }

    return readStreamingResponse(response, onText);
}

module.exports = {
    getChatBaseUrl,
    getChatModel,
    requestChat,
};
