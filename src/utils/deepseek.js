const { getConfig, getDeepseekApiKey } = require('../storage');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MAX_TOKENS = 8192;

function getDeepSeekModel() {
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
        throw new Error('No DeepSeek API key configured');
    }

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: getDeepSeekModel(),
            messages,
            stream: true,
            max_tokens: DEEPSEEK_MAX_TOKENS,
        }),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`DeepSeek returned HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
    }

    return readStreamingResponse(response, onText);
}

module.exports = {
    getDeepSeekModel,
    requestChat,
};
