/**
 * Shared OpenAI function-calling helper.
 *
 * fiDetectionService and docfilesService each carried a verbatim copy of this retry
 * loop, with the two copies already drifting apart (different retry counts, and only
 * one of them clamping message length the same way). Both copies shared two defects:
 *
 *   1. `response.choices[0].message.function_call.arguments` was read unguarded. When
 *      the model answered with prose instead of calling the function, that threw a
 *      TypeError - which is not a SyntaxError, so it bypassed the JSON retry below and
 *      propagated to the caller, where it was recorded as a non-match.
 *   2. Only timeouts and ECONNRESET were retried. A 429 or 5xx threw immediately and was
 *      likewise swallowed as a non-match, so a rate-limit burst was indistinguishable
 *      from a night with no FI requests in it.
 */

/** The model replied with prose instead of calling the requested function. */
class MissingFunctionCallError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingFunctionCallError';
  }
}

/** Transient API conditions worth retrying. */
function isRetriableApiError(error) {
  if (!error) return false;
  if (error.name === 'APITimeoutError' || error.name === 'APIConnectionError') return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(error.code)) return true;

  const status = error.status || error.response?.status;
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Call a function-calling completion and return the parsed arguments object.
 *
 * @param {object}   opts
 * @param {object}   opts.client       OpenAI client
 * @param {object[]} opts.messages     Chat messages; content is stringified and clamped
 * @param {object[]} opts.functions    Function schemas
 * @param {string}   opts.functionName Function the model is forced to call
 * @param {string}   opts.model
 * @param {number}   opts.temperature
 * @param {number}   opts.topP
 * @param {number}   opts.maxMsgChars  Per-message content clamp
 * @param {number}   opts.maxAttempts
 * @param {object}   opts.logger
 */
async function runFunctionChat({
  client,
  messages,
  functions,
  functionName,
  model,
  temperature,
  topP,
  maxMsgChars,
  maxAttempts,
  logger
}) {
  const safeMessages = messages.map(m => ({
    ...m,
    content: String(m.content || '').slice(0, maxMsgChars)
  }));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature,
        top_p: topP,
        messages: safeMessages,
        functions,
        function_call: { name: functionName }
      });

      const call = response.choices?.[0]?.message?.function_call;
      if (!call?.arguments) {
        throw new MissingFunctionCallError(
          `Model did not call ${functionName}; returned ` +
          `"${String(response.choices?.[0]?.message?.content || '').slice(0, 120)}"`
        );
      }

      return JSON.parse(call.arguments);

    } catch (error) {
      const isLastAttempt = attempt === maxAttempts;

      if (isRetriableApiError(error) && !isLastAttempt) {
        const wait = 2.0 * (2 ** (attempt - 1)) + Math.random() * 0.3;
        logger.warn(
          `${error.constructor.name} (${error.status || error.code || 'n/a'}) on ${functionName} – ` +
          `retry ${attempt}/${maxAttempts} in ${wait.toFixed(1)}s`
        );
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        continue;
      }

      const isMalformed = (error instanceof SyntaxError && error.message.includes('JSON')) ||
        error instanceof MissingFunctionCallError;

      if (isMalformed && !isLastAttempt) {
        logger.warn(`Malformed model output on ${functionName} (${error.message}); retry ${attempt}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      throw error;
    }
  }

  throw new Error(`runFunctionChat: giving up after ${maxAttempts} attempts on ${functionName}`);
}

module.exports = {
  runFunctionChat,
  isRetriableApiError,
  MissingFunctionCallError
};
