// Transcript read bounds shared by the legacy JSONL loader and the SQLite
// transcript-store loader, so both readers stay on one ceiling.

/**
 * Maximum transcript bytes read back for CLI session history.
 *
 * The JSONL loader applies this as a file window; the store loader applies it
 * as an aggregate over the persisted event payloads it would otherwise parse.
 */
export const MAX_CLI_SESSION_HISTORY_BYTES = 5 * 1024 * 1024;
