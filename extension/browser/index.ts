/**
 * yu-agent — Browser tools module
 *
 * Provides web search and page extraction capabilities for agent use.
 * Powered by DuckDuckGo (no API key required).
 */

import { WebSearch, WebFetcher } from 'duckduckgo-websearch';

// ── Internal state ──────────────────────────────────────────

let _searcher: WebSearch | null = null;
let _fetcher: WebFetcher | null = null;

function getSearcher(): WebSearch {
  if (!_searcher) _searcher = new WebSearch();
  return _searcher;
}

function getFetcher(): WebFetcher {
  if (!_fetcher) _fetcher = new WebFetcher();
  return _fetcher;
}

// ── Types ───────────────────────────────────────────────────

export interface WebSearchOptions {
  query: string;
  limit?: number;
}

export interface WebExtractOptions {
  url: string;
  maxLength?: number;
}

export interface BrowserActionResult {
  text: string;
  detail?: Record<string, unknown>;
  isError?: boolean;
}

// ── Actions ─────────────────────────────────────────────────

/**
 * Search the web via DuckDuckGo.
 * Returns formatted results with title, link, and snippet.
 */
export async function webSearch(opts: WebSearchOptions): Promise<BrowserActionResult> {
  const query = opts.query.trim();
  if (!query) {
    return { text: 'Error: query is required for web_search.', isError: true };
  }

  const limit = Math.min(opts.limit ?? 5, 20);

  try {
    const searcher = getSearcher();
    const results = await searcher.search(query, { maxResults: limit });

    if (!results || results.length === 0) {
      return { text: `No results found for "${query}".`, detail: { query, results: 0 } };
    }

    const formatted = searcher.formatResultsForLLM(results);

    return {
      text: `--- Web Search Results for "${query}" ---\n${formatted}`,
      detail: { query, results: results.length },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Web search failed: ${msg}`, isError: true };
  }
}

/**
 * Fetch and parse a webpage to clean text content.
 */
export async function webExtract(opts: WebExtractOptions): Promise<BrowserActionResult> {
  const url = opts.url.trim();
  if (!url) {
    return { text: 'Error: url is required for web_extract.', isError: true };
  }

  try {
    const fetcher = getFetcher();
    const content = await fetcher.fetchAndParse(url, opts.maxLength ?? 10_000);

    if (!content || content.trim().length === 0) {
      return { text: `Page at ${url} returned empty content.`, detail: { url, chars: 0 } };
    }

    const truncated = content.length > 10_000
      ? content.slice(0, 10_000) + '\n... [truncated]'
      : content;

    return {
      text: `--- Content from ${url} ---\n${truncated}`,
      detail: { url, chars: content.length, truncated: content.length > 10_000 },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Failed to extract ${url}: ${msg}`, isError: true };
  }
}

