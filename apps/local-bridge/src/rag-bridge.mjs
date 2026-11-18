import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_SCRIPT = path.join(__dirname, 'rag_indexer.py');

/**
 * Injection-safe Node wrapper around rag_indexer.py (SQLite FTS5).
 */
export class LocalRagBridge {
  /**
   * @param {string} dbPath
   * @param {string} [pythonBin='python3']
   */
  constructor(dbPath, pythonBin = 'python3') {
    this.dbPath = dbPath;
    this.pythonBin = pythonBin;
  }

  async #run(args) {
    const { stdout } = await execFileAsync(
      this.pythonBin,
      [INDEXER_SCRIPT, '--db', this.dbPath, ...args],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    return JSON.parse(stdout.trim() || '{}');
  }

  async indexPaths(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: true, scannedFiles: 0, indexedFiles: 0, skippedUnchanged: 0 };
    }
    return this.#run(['index', ...paths.map(String)]);
  }

  async query(queryText, maxTokens = 420, limit = 3) {
    if (!queryText || !String(queryText).trim()) {
      return { ok: true, snippets: [], usedTokens: 0 };
    }
    return this.#run([
      'query',
      '--q',
      String(queryText),
      '--max-tokens',
      String(maxTokens),
      '--limit',
      String(limit)
    ]);
  }

  async stats() {
    return this.#run(['stats']);
  }

  async clear() {
    return this.#run(['clear']);
  }
}
