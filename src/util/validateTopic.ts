const topicEncoder = new TextEncoder();
const maxTopicBytes = 65_535;
const unpairedSurrogate = /[\uD800-\uDFFF]/u;

/** Whether `value` is an MQTT 5 UTF-8 string: at most 65,535 bytes, with no U+0000 and no unpaired surrogate. */
export function validateMqttString(value: string): boolean {
  const { length } = value;
  if (length > maxTopicBytes || value.includes('\u0000') || unpairedSurrogate.test(value)) return false;
  // A UTF-16 code unit uses at most three UTF-8 bytes. A surrogate pair uses four bytes across two units.
  return length <= maxTopicBytes / 3 || topicEncoder.encode(value).byteLength <= maxTopicBytes;
}

function validateTopicString(topic: string): boolean {
  return topic.length !== 0 && validateMqttString(topic);
}

export function validateTopicName(topic: string): boolean {
  return !topic.includes('+') && !topic.includes('#') && validateTopicString(topic);
}

/**
 * Validate a Topic Filter's MQTT string and wildcard syntax.
 * Topics can support Multi-level wildcards (‘#’ U+0023) and single-level wildcards (‘+’ U+002B).
 *
 * The multi-level wildcard character MUST be specified either on its own or following a topic level separator.
 * In either case it MUST be the last character specified in the Topic Filter.
 *
 * The single-level wildcard character MUST occupy an entire level of the filter.
 * For example: "+" is valid, "+/tennis/#" is valid, "sport+" is not valid.
 *
 * Topics beginning with $: The Server MUST NOT match Topic Filters starting with a wildcard character with Topic Names
 *
 * Topic names and topic filters must not include the null character (Unicode U+0000)
 *
 * Topic names and Topic Filters are UTF-8 encoded strings; they must not encode to more than 65,535 bytes.
 *
 * @param {String} topic - A topic
 * @returns {Boolean} If the topic is valid, returns true. Otherwise, returns false.
 */
export function validateTopic(topic: string) {
  if (!validateTopicString(topic)) return false;
  if (!topic.includes('+') && !topic.includes('#')) return true;
  const levels: string[] = topic.split('/');

  for (const [levelIndex, level] of levels.entries()) {
    // If SLWC, MUST occupy entire level.
    if (level === '+') {
      continue;
    }

    if (level === '#') {
      // Validate MLWC at end of topic filter.
      return levelIndex === levels.length - 1;
    }

    // Level must not contain more than one MLWC or SLWC character.
    if (level.includes('+') || level.includes('#')) {
      return false;
    }
  }
  return true;
}

/**
 * Validate an array of topics to see if any of them is valid or not
 * @param {Array} topics - Array of topics
 * @returns {String} If the topics is valid, returns null. Otherwise, returns the invalid one
 */
export function validateTopics(topics: readonly string[]) {
  if (topics.length === 0) {
    return 'empty_topic_list';
  }
  for (const topic of topics) {
    if (!validateTopic(topic)) {
      return topic;
    }
  }
  return null;
}
