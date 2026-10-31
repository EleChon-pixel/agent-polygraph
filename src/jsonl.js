import fs from "node:fs";
import readline from "node:readline";

/**
 * Stream parsed records from a JSONL file. `keep(line)` is a cheap substring
 * prefilter so we don't JSON.parse the many large records we never look at.
 */
export async function* readJsonl(file, keep = () => true, stats = {}) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  stats.lines ??= 0;
  stats.kept ??= 0;
  for await (const line of rl) {
    if (!line) continue;
    stats.lines++;
    if (!keep(line)) continue;
    stats.kept++;
    try {
      yield JSON.parse(line);
    } catch {
      // partial line from a session that is still being written
    }
  }
}
