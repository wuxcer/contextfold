/**
 * Session Index — Public API
 */

export { buildSessionIndex } from "./builder.js";
export { SessionIndexQuery } from "./query.js";
export { saveIndex, loadIndex, isIndexStale, getIndexFilePath } from "./persistence.js";
export { parseSessionFile } from "./parser.js";

export type {
  SessionIndex,
  SessionMeta,
  TurnIndex,
  TopicIndex,
  TopicStatus,
  SummaryRef,
  IndexStats,
  EntryType,
  MessageRole,
} from "./types.js";
