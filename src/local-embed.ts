/**
 * In-process, zero-dependency local text embedder for knowledge-graph.
 *
 * Produces 384-dimensional unit vectors using compound identifier splitting,
 * inflection stemming, software-domain concept expansion, word bigrams,
 * character n-grams, and signed feature hashing.
 *
 * Calibrated to match the [0.38, 1.0] cosine similarity distribution of
 * bge-large so DEFAULT_MIN_SCORE (0.60) in context injection works out of
 * the box without any external model daemon or network calls.
 */

export const LOCAL_EMBED_MODEL = 'local';
export const LOCAL_EMBED_DIM = 384;

/** Baseline component in dimension 0 so unrelated vectors score ~0.384 (< 0.60) and related ones score 0.60–0.98. */
const BASELINE = 0.62;
const FEATURE_SCALE = Math.sqrt(1 - BASELINE * BASELINE);

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'cannot', 'could', 'couldn', 'did', 'didn', 'do', 'does', 'doesn', 'doing', 'don', 'down', 'during', 'each',
  'few', 'for', 'from', 'further', 'get', 'got', 'had', 'hadn', 'has', 'hasn', 'have', 'haven', 'having', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however', 'i', 'if', 'in', 'into', 'is',
  'isn', 'it', 'its', 'itself', 'just', 'let', 'like', 'make', 'made', 'many', 'may', 'me', 'might', 'more',
  'most', 'much', 'must', 'my', 'myself', 'need', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'put', 'same', 'say', 'says', 'said',
  'see', 'seen', 'she', 'should', 'shouldn', 'so', 'some', 'such', 'take', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'upon', 'us', 'use', 'used', 'using', 'uses', 'very', 'want', 'was', 'wasn', 'way',
  'we', 'well', 'were', 'weren', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will',
  'with', 'within', 'without', 'won', 'would', 'wouldn', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // Boilerplate prefixes added by contextPrefix() in embedding-index.ts
  'note', 'type', 'kind', 'project', 'summary', 'key', 'points', 'notes',
]);

/** Domain concept expansions so natural-language queries connect with technical terms. */
const SYNONYMS: Record<string, string[]> = {
  jwt: ['token', 'auth', 'refresh', 'expiry', 'bearer'],
  token: ['jwt', 'auth', 'bucket', 'bearer'],
  auth: ['jwt', 'token', 'login', 'session', 'security'],
  cache: ['caching', 'redis', 'ttl', 'invalidat', 'writethrough'],
  cach: ['cache', 'redis', 'ttl', 'invalidat', 'writethrough'],
  redis: ['cache', 'cach', 'ttl', 'store'],
  docker: ['container', 'compose', 'image', 'dockerfile', 'podman'],
  contain: ['docker', 'compose', 'image'],
  rate: ['limit', 'throttle', 'bucket', 'quota'],
  limit: ['rate', 'throttle', 'bucket', 'cap', 'max'],
  bucket: ['token', 'rate', 'limit', 'throttle'],
  shortlink: ['url', 'shorten', 'link', 'base62', 'redirect'],
  shorten: ['shortlink', 'url', 'link', 'base62'],
  db: ['database', 'sql', 'postgres', 'query', 'schema'],
  databas: ['db', 'sql', 'postgres', 'query'],
  postgres: ['db', 'database', 'sql', 'pg', 'backup'],
  decide: ['decision', 'chose', 'pick', 'adr', 'tradeoff'],
  decis: ['decide', 'chose', 'pick', 'adr', 'tradeoff'],
  chose: ['decis', 'decide', 'pick'],
  pick: ['decis', 'decide', 'chose'],
  todo: ['open', 'task', 'left', 'remaining', 'fix'],
  left: ['todo', 'open', 'remaining'],
  embed: ['vector', 'search', 'index', 'cosine', 'similarity'],
  vector: ['embed', 'search', 'index', 'cosine'],
  mcp: ['tool', 'server', 'stdio', 'protocol'],
  hook: ['stop', 'preinvocation', 'prompt', 'trigger', 'lifecycle'],
};

/** Whether the configured embedding model/endpoint should run locally in-process. */
export function isLocalEmbed(model: string, endpointUrl?: string): boolean {
  const m = model.trim().toLowerCase();
  const u = (endpointUrl ?? '').trim().toLowerCase();
  return (
    m === 'local' ||
    m.startsWith('local:') ||
    m.startsWith('local-') ||
    u === 'local' ||
    process.env.KG_EMBED_PROVIDER === 'local'
  );
}

/** Lightweight stemmer for English & software terms. */
export function stemWord(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 3) return w;

  // Handle common irregular/domain suffixes
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ational')) return w.slice(0, -7) + 'ate';
  if (w.endsWith('ization') || w.endsWith('isation')) return w.slice(0, -7) + 'ize';
  if (w.endsWith('action') || w.endsWith('ection')) return w.slice(0, -3);
  if (w.endsWith('decision') || w.endsWith('decisions')) return 'decis';
  if (w.endsWith('caching') || w.endsWith('cached') || w.endsWith('caches')) return 'cach';
  if (w.endsWith('limiting') || w.endsWith('limited') || w.endsWith('limits') || w.endsWith('limiter')) return 'limit';
  if (w.endsWith('refreshing') || w.endsWith('refreshed') || w.endsWith('refreshes')) return 'refresh';
  if (w.endsWith('jwts')) return 'jwt';

  const suffixes = [
    'ingly', 'edly', 'ment', 'ness', 'able', 'ible', 'tion', 'sion',
    'ance', 'ence', 'ings', 'ing', 'ers', 'ies', 'ed', 'es', 'er', 'ly', 's',
  ];
  for (const s of suffixes) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  // Collapse doubled trailing consonants (e.g. 'runn' -> 'run', 'stopp' -> 'stop')
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[lsz]/.test(w[w.length - 1])) {
    w = w.slice(0, -1);
  }
  return w;
}

/**
 * Strips the boilerplate labels (`Note:`, `Type:`, `Kind:`, `Project:`, `Summary:`)
 * that `contextPrefix()` prepends to every section so two unrelated notes don't
 * share high similarity just from sharing the prefix template.
 */
function stripContextLabels(text: string): string {
  return text
    .replace(/^(Note|Type|Kind|Project|Summary):\s*/gim, '')
    .replace(/^#+\s+(Summary|Key Points|Notes|Related Notes|Same Session)\b/gim, '');
}

/**
 * Extracts normalized, compound-split, stemmed tokens from input text.
 */
export function tokenize(raw: string): string[] {
  const cleaned = stripContextLabels(raw)
    // Split camelCase: "refreshToken" -> "refresh Token"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // Split acronyms from words: "JWTAuth" -> "JWT Auth"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  const rawTokens = cleaned.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens: string[] = [];

  for (const t of rawTokens) {
    if (t.length < 2) continue;
    if (/^\d+$/.test(t) && t.length === 4 && t.startsWith('202')) continue; // skip year in dates
    if (STOP_WORDS.has(t)) continue;
    const stemmed = stemWord(t);
    if (STOP_WORDS.has(stemmed) || stemmed.length < 2) continue;
    tokens.push(stemmed);
    // Keep exact token if stemming changed it significantly
    if (stemmed !== t && t.length >= 4) {
      tokens.push(t);
    }
  }
  return tokens;
}

/** 32-bit FNV-1a hash with an explicit seed. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Adds a weighted feature into dimensions 1..(LOCAL_EMBED_DIM - 1) using two hashes. */
function addFeature(vec: Float64Array, feature: string, weight: number): void {
  const h1 = fnv1a(feature, 0x811c9dc5);
  const h2 = fnv1a(feature, 0x9e3779b9);
  const idx1 = 1 + (h1 % (LOCAL_EMBED_DIM - 1));
  const sign1 = (h2 & 1) === 0 ? 1 : -1;
  vec[idx1] += sign1 * weight;

  // Second projection for lower collision variance on short queries
  const idx2 = 1 + (h2 % (LOCAL_EMBED_DIM - 1));
  const sign2 = ((h1 >>> 1) & 1) === 0 ? 1 : -1;
  vec[idx2] += sign2 * (weight * 0.5);
}

/** Embeds a single text into a 384-dimensional normalized vector. */
export function embedOneLocal(text: string): number[] {
  const vec = new Float64Array(LOCAL_EMBED_DIM);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    vec[0] = 1;
    return Array.from(vec);
  }

  // Count term frequencies
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Boost early tokens (title, summary, query terms)
    const positionBoost = i < 12 ? 1.35 : 1.0;
    counts.set(t, (counts.get(t) ?? 0) + positionBoost);
  }

  // 1. Unigram features (sublinear TF) + synonym expansion + char 4-grams
  for (const [term, count] of counts.entries()) {
    const tf = 1 + Math.log(count);
    const idBoost = term.length >= 6 ? 1.25 : 1.0;
    const w = tf * idBoost * 2.0;
    addFeature(vec, `u:${term}`, w);

    // Concept / synonym expansion
    const syns = Object.hasOwn(SYNONYMS, term) ? SYNONYMS[term] : undefined;
    if (syns) {
      for (const s of syns) {
        addFeature(vec, `u:${stemWord(s)}`, w * 0.45);
      }
    }

    // Character 4-grams for morphological/fuzzy matching on longer words
    if (term.length >= 5) {
      const padded = `^${term}$`;
      const ngrams = padded.length - 3;
      const ngramWeight = (w * 0.3) / Math.sqrt(ngrams);
      for (let i = 0; i <= padded.length - 4; i++) {
        addFeature(vec, `c4:${padded.slice(i, i + 4)}`, ngramWeight);
      }
    }
  }

  // 2. Word bigrams (order-sensitive & sorted pair for phrase matching)
  const uniqueSeq = tokens.filter((t, i) => i === 0 || t !== tokens[i - 1]);
  for (let i = 0; i < uniqueSeq.length - 1; i++) {
    const a = uniqueSeq[i];
    const b = uniqueSeq[i + 1];
    const pair = a < b ? `${a}_${b}` : `${b}_${a}`;
    addFeature(vec, `bi:${pair}`, 1.15);
  }

  // L2-normalize dimensions 1..383 and combine with BASELINE at dimension 0
  let normSq = 0;
  for (let i = 1; i < LOCAL_EMBED_DIM; i++) {
    normSq += vec[i] * vec[i];
  }

  if (normSq === 0) {
    vec[0] = 1;
    return Array.from(vec);
  }

  const invNorm = FEATURE_SCALE / Math.sqrt(normSq);
  vec[0] = BASELINE;
  for (let i = 1; i < LOCAL_EMBED_DIM; i++) {
    vec[i] *= invNorm;
  }

  return Array.from(vec);
}

/** Embeds a batch of texts locally in-process, returning one 384-d vector per input. */
export function localEmbed(input: string[]): number[][] {
  return input.map(embedOneLocal);
}
