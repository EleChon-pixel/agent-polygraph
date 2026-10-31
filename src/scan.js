import * as claude from "./sources/claude.js";
import * as codex from "./sources/codex.js";
import { analyzeSession } from "./analyze.js";
import { applyRecords } from "./record.js";

export const SOURCES = { claude, codex };

/**
 * Discover, parse and analyze sessions.
 * opts: { agents: ["claude","codex"], since: ms timestamp, project: substring, exclude: [id prefix or cwd substring],
 *         roots: {claude, codex}, records: false to ignore `record` data, enrich: async (session) => void,
 *         onProgress }
 */
export async function scan(opts = {}) {
  const agents = opts.agents?.length ? opts.agents : Object.keys(SOURCES);
  let entries = [];
  for (const a of agents) {
    const src = SOURCES[a];
    entries.push(...src.discover(opts.roots?.[a] || src.defaultRoot()));
  }
  if (opts.since) entries = entries.filter((e) => e.mtime >= opts.since);

  const results = [];
  results.skipped = []; // session files we couldn't read: a quiet gap would look like a full audit
  results.unrecognized = []; // files with content in a format we don't know (a new agent version?)
  let done = 0;
  const queue = [...entries];
  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      try {
        const session = await SOURCES[entry.agent].parse(entry);
        if (opts.project && !(session.cwd || "").includes(opts.project)) continue;
        // --exclude: a session id prefix or a piece of its working directory
        if (opts.exclude?.some((x) => entry.id.startsWith(x) || (session.cwd || "").includes(x))) continue;
        if (opts.since && session.end && session.end < opts.since) continue;
        if (session.unrecognized) {
          results.unrecognized.push({ file: entry.files[0], agent: entry.agent });
          continue;
        }
        if (!session.events.length) continue;
        // evidence outside the logs: `record` snapshots and terminal runs (local files),
        // then --ci (GitHub) when asked for
        if (opts.records !== false) applyRecords(session);
        if (opts.enrich) await opts.enrich(session);
        results.push(analyzeSession(session));
      } catch (err) {
        results.skipped.push({ file: entry.files[0], error: err.message });
        if (process.env.POLYGRAPH_DEBUG) console.error(`skip ${entry.files[0]}: ${err.message}`);
      } finally {
        opts.onProgress?.(++done, entries.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, entries.length || 1) }, worker));
  const { skipped, unrecognized } = results;
  results.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  Object.assign(results, { skipped, unrecognized });
  return results;
}
