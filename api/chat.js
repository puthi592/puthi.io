// ─────────────────────────────────────────────────────────────
// CP-AI backend (Vercel serverless function: /api/chat)
//
// Model order (first one that works is used):
//   1. the model chosen in the website Settings (or GROQ_MODEL env var)
//   2. openai/gpt-oss-120b  (supports live web search)
//   3. qwen/qwen3.8-27b
//   4. openai/gpt-oss-20b   (supports live web search)
//
// Live web search uses Groq's built-in "browser_search" tool, which only
// the openai/gpt-oss models support. Other models answer from their own
// knowledge.
// ─────────────────────────────────────────────────────────────

const FALLBACK_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Phnom_Penh';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 55000;

// Remove stray characters (commas, spaces, quotes, backticks) from a model name.
const cleanModel = (m) => (typeof m === 'string' ? m.replace(/[^\w./:-]/g, '') : '');

const supportsSearch = (m) => m.startsWith('openai/gpt-oss');
const isQwen = (m) => m.startsWith('qwen/');

// True when Groq says the model does not exist / is retired / is not allowed.
const isModelError = (status, data) => {
  const code = data?.error?.code;
  const msg = String(data?.error?.message || '');
  return (
    [400, 403, 404].includes(status) &&
    (code === 'model_not_found' ||
      code === 'model_decommissioned' ||
      /does not exist|do not have access|decommissioned/i.test(msg))
  );
};

// True when the request failed because of the search tool (not the model).
const isToolError = (status, data) =>
  status === 400 && /tool|browser_search/i.test(String(data?.error?.message || ''));

// Add today's date/time to the system prompt so the AI knows "now".
function withDate(messages) {
  let now;
  try {
    now = new Date().toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });
  } catch {
    now = new Date().toUTCString();
  }
  const note = `Current date and time: ${now} (${TIMEZONE}).`;
  if (messages[0]?.role === 'system') {
    return [{ role: 'system', content: `${messages[0].content}\n\n${note}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: note }, ...messages];
}

async function callGroq(apiKey, model, messages, useSearch) {
  const body = { model, messages };
  const searching = useSearch && supportsSearch(model);
  if (searching) body.tools = [{ type: 'browser_search' }];
  if (isQwen(model)) body.reasoning_format = 'hidden'; // return only the final answer

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = { error: { message: `Unexpected response from Groq (HTTP ${response.status}).` } };
  }
  return { response, data, searching };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { model, messages, search } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server missing GROQ_API_KEY environment variable.' });
  }

  // Keep only valid chat messages.
  const clean = Array.isArray(messages)
    ? messages
        .filter((m) => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }))
    : [];
  if (clean.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array.' });
  }

  const convo = withDate(clean);
  const wantSearch = search !== false; // pages like Translate/Code send search:false

  // Models to try (requested one first), without duplicates.
  const candidates = [cleanModel(model), cleanModel(process.env.GROQ_MODEL), ...FALLBACK_MODELS]
    .filter((m, i, arr) => m && arr.indexOf(m) === i);

  let lastStatus = 500;
  let lastData = { error: 'No model could be used.' };

  try {
    for (const candidate of candidates) {
      let result = await callGroq(apiKey, candidate, convo, wantSearch);

      // If only the search tool caused the error, retry the same model without it.
      if (!result.response.ok && result.searching && isToolError(result.response.status, result.data)) {
        console.error(`Search tool failed on "${candidate}":`, result.data);
        result = await callGroq(apiKey, candidate, convo, false);
      }

      if (result.response.ok) {
        res.setHeader('x-model-used', candidate);
        res.setHeader('x-search-used', result.searching ? 'true' : 'false');
        return res.status(200).json(result.data);
      }

      lastStatus = result.response.status;
      lastData = result.data;
      console.error(`Groq error with model "${candidate}":`, result.data);

      // Only move on to the next model when the problem is the model itself.
      if (!isModelError(result.response.status, result.data)) break;
    }

    return res.status(lastStatus).json(lastData);
  } catch (error) {
    console.error(error);
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return res.status(504).json({ error: 'The AI took too long to answer. Please try again.' });
    }
    return res.status(500).json({ error: error.message });
  }
}
