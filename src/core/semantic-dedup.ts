import { cosineSim } from './embed';

// Semantic de-duplication of job postings using their sentence embeddings. This
// catches what the lexical fuzzy dedup (normalizeCompany + role-token Jaccard in
// scan.ts) misses: the SAME employer reposting a role under a reworded title
// ("Backend Engineer" vs "Software Engineer, Server-Side") whose token sets are
// too different for Jaccard ≥ 0.7 but whose JDs embed nearly identically.
//
// Precision is the whole game here — a false merge HIDES a real, distinct opening,
// which is worse than showing a near-duplicate. Two structural guards keep it
// conservative:
//   1. Same `companyNorm` only. Two roles at *different* employers can have
//      near-identical generic JDs (cosine ~0.9+); requiring the same normalized
//      company makes it impossible to collapse "Data Engineer @ Acme" with
//      "Data Engineer @ Globex". Cross-employer dedup is rarer and far riskier —
//      deliberately out of scope for v1.
//   2. A high cosine threshold (DEFAULT_DEDUP_THRESHOLD). Untuned against real
//      data yet (the corpus was unembedded when this shipped), so it starts
//      conservative; raise/lower once field data exists.

// Cosine at/above which two same-company postings are treated as the same job.
// Conservative on purpose — see the precision note above.
export const DEFAULT_DEDUP_THRESHOLD = 0.95;

export interface DedupItem {
  id: number;
  // Normalized company name (see normalizeCompany). Empty string ⇒ never matched
  // (we can't trust the company guard without it).
  companyNorm: string;
  vec: Float32Array;
  // Higher = preferred as the cluster's canonical (kept + L2-scored). The runner
  // ranks by information richness (has JD, salary disclosed). Ties break on the
  // lowest id (≈ earliest inserted), so the choice is deterministic.
  priority: number;
}

export interface DuplicateCluster {
  canonicalId: number;
  duplicateIds: number[];
}

/**
 * Group items into duplicate clusters within each normalized company. Greedy
 * single-linkage to the cluster's seed (its highest-priority member), NOT
 * transitive chaining — a duplicate must be ≥ threshold to the canonical it's
 * attached to, never merely to some intermediate, which keeps drift out. Only
 * clusters that actually have ≥1 duplicate are returned. Pure: no DB, no model.
 */
export function clusterDuplicates(
  items: DedupItem[],
  threshold: number = DEFAULT_DEDUP_THRESHOLD,
): DuplicateCluster[] {
  const byCompany = new Map<string, DedupItem[]>();
  for (const it of items) {
    if (!it.companyNorm) continue; // no trustworthy company guard → skip
    const group = byCompany.get(it.companyNorm);
    if (group) group.push(it);
    else byCompany.set(it.companyNorm, [it]);
  }

  const clusters: DuplicateCluster[] = [];
  for (const group of byCompany.values()) {
    if (group.length < 2) continue;

    // Highest priority first (canonical preference), lowest id breaks ties.
    const ordered = [...group].sort((a, b) => b.priority - a.priority || a.id - b.id);
    const assigned = new Set<number>();

    for (const seed of ordered) {
      if (assigned.has(seed.id)) continue;
      assigned.add(seed.id);
      const duplicateIds: number[] = [];
      for (const other of ordered) {
        if (assigned.has(other.id)) continue;
        if (cosineSim(seed.vec, other.vec) >= threshold) {
          assigned.add(other.id);
          duplicateIds.push(other.id);
        }
      }
      if (duplicateIds.length > 0) {
        clusters.push({ canonicalId: seed.id, duplicateIds });
      }
    }
  }

  return clusters;
}
