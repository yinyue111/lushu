// Server-sent-event reader for model responses (chat_completions and responses wire APIs).
// It folds the stream back into the same shape a non-streaming call returns, so the rest of the
// pipeline does not care which one was used, and calls onActivity on every chunk so the caller can
// run an idle timeout ("no tokens for N seconds") instead of one long wait.

/**
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ wireApi: string, onActivity?: (info: { chars: number, first: boolean }) => void }} options
 * @returns {Promise<any>} a non-streaming-shaped response object
 */
export async function readModelStream(body, { wireApi, onActivity = () => {} }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = null;
  let usage = null;
  let completed = null;
  let status = null;
  let incompleteDetails = null;
  let error = null;
  let first = true;
  const handle = (payload) => {
    if (payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.error) error = event.error;
    if (wireApi === 'chat_completions') {
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string') text += delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (event.usage) usage = event.usage;
    } else {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        completed = event.response ?? null;
        status = event.response?.status ?? null;
        incompleteDetails = event.response?.incomplete_details ?? null;
        if (event.response?.usage) usage = event.response.usage;
        if (event.response?.error) error = event.response.error;
      }
    }
  };
  for await (const chunk of /** @type {any} */ (body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    onActivity({ chars: text.length, first });
    first = false;
  }
  if (buffer.startsWith('data:')) handle(buffer.slice(5).trim());
  if (error) return { error, streamed: true };
  if (wireApi === 'chat_completions') {
    return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: finishReason }], usage, streamed: true };
  }
  return { ...(completed ?? {}), output_text: text, status: status ?? 'completed', incomplete_details: incompleteDetails, usage, streamed: true };
}
