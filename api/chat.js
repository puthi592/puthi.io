// Models to try, in order, if the requested one is missing or not allowed for your key.
const FALLBACK_MODELS = ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

// Remove stray characters (commas, spaces, quotes, backticks) from a model name.
const cleanModel = (m) => (typeof m === 'string' ? m.replace(/[^\w./:-]/g, '') : '');

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { model, messages } = req.body || {};
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Server missing GROQ_API_KEY environment variable.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array.' });
  }

  // Build the list of models to try (requested one first), without duplicates.
  const candidates = [
    cleanModel(model),
    cleanModel(process.env.GROQ_MODEL),
    ...FALLBACK_MODELS,
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  let lastStatus = 500;
  let lastData = { error: 'No model could be used.' };

  try {
    for (const candidate of candidates) {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model: candidate, messages })
      });

      const data = await response.json();

      if (response.ok) {
        res.setHeader('x-model-used', candidate);
        return res.status(200).json(data);
      }

      lastStatus = response.status;
      lastData = data;
      console.error(`Groq error with model "${candidate}":`, data);

      // Only move on to the next model when the problem is the model itself.
      if (!isModelError(response.status, data)) break;
    }

    return res.status(lastStatus).json(lastData);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
