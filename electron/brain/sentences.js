/**
 * Split an LLM token stream into speakable phrases.
 * Emits as soon as a sentence boundary is followed by whitespace;
 * remaining text is flushed when the stream ends.
 */

const BOUNDARY = /[.!?…]["')\]]*(?:\s+|$)/g;

function splitOff(buffer, flush) {
  const sentences = [];
  let last = 0;
  BOUNDARY.lastIndex = 0;
  let m;
  while ((m = BOUNDARY.exec(buffer))) {
    const consumed = m.index + m[0].length;
    const endedAtEof = consumed >= buffer.length;
    const hasTrailingSpace = /\s$/.test(m[0]);
    if (endedAtEof && !hasTrailingSpace && !flush) {
      break;
    }
    const sentence = buffer.slice(last, m.index + m[0].length).trim();
    if (sentence.length) sentences.push(sentence);
    last = consumed;
  }

  // Long clause with a comma — don't wait forever for a period.
  if (!sentences.length && flush === false && buffer.length >= 140) {
    const comma = buffer.lastIndexOf(', ');
    if (comma >= 48) {
      const sentence = buffer.slice(0, comma + 1).trim();
      if (sentence) {
        sentences.push(sentence);
        last = comma + 1;
      }
    }
  }

  return { sentences, rest: buffer.slice(last) };
}

export function createSentenceBuffer() {
  let buf = '';

  return {
    /**
     * @param {string} token
     * @returns {string[]}
     */
    push(token) {
      if (!token) return [];
      buf += token;
      const { sentences, rest } = splitOff(buf, false);
      buf = rest;
      return sentences;
    },

    /**
     * @returns {string[]}
     */
    flush() {
      const { sentences, rest } = splitOff(buf, true);
      buf = '';
      const tail = rest.trim();
      if (tail) sentences.push(tail);
      return sentences.filter(Boolean);
    },
  };
}
