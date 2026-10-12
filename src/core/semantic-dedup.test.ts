import { describe, expect, test } from 'bun:test';
import { clusterDuplicates, type DedupItem, DEFAULT_DEDUP_THRESHOLD } from './semantic-dedup';

// Build a unit 2-d vector at angle θ (radians). cosine(a,b) = cos(θa − θb), so a
// small angular gap is a high cosine — handy for placing items just above/below
// the threshold deterministically.
function unit(theta: number): Float32Array {
  return new Float32Array([Math.cos(theta), Math.sin(theta)]);
}

function item(id: number, companyNorm: string, theta: number, priority = 0, triaged = false): DedupItem {
  return { id, companyNorm, vec: unit(theta), priority, triaged };
}

describe('clusterDuplicates', () => {
  test('two same-company near-identical postings cluster together', () => {
    const clusters = clusterDuplicates([
      item(1, 'acme', 0),
      item(2, 'acme', 0.01), // cosine(1,2) ≈ 0.99995 ≥ 0.95
    ]);
    expect(clusters).toEqual([{ canonicalId: 1, duplicateIds: [2] }]);
  });

  test('same company but low cosine → no cluster', () => {
    // 0.5 rad apart → cosine ≈ 0.878 < 0.95
    expect(clusterDuplicates([item(1, 'acme', 0), item(2, 'acme', 0.5)])).toEqual([]);
  });

  test('different companies never cluster, even at cosine ~1', () => {
    expect(clusterDuplicates([item(1, 'acme', 0), item(2, 'globex', 0.001)])).toEqual([]);
  });

  test('empty companyNorm is skipped (no trustworthy guard)', () => {
    expect(clusterDuplicates([item(1, '', 0), item(2, '', 0.001)])).toEqual([]);
  });

  test('canonical is the highest-priority member', () => {
    const clusters = clusterDuplicates([
      item(1, 'acme', 0, 0), // low priority, lower id
      item(2, 'acme', 0.01, 5), // high priority → canonical despite higher id
    ]);
    expect(clusters).toEqual([{ canonicalId: 2, duplicateIds: [1] }]);
  });

  test('priority ties break on the lowest id', () => {
    const clusters = clusterDuplicates([
      item(3, 'acme', 0.01, 0),
      item(2, 'acme', 0, 0),
      item(5, 'acme', 0.005, 0),
    ]);
    expect(clusters[0].canonicalId).toBe(2);
    expect(clusters[0].duplicateIds.sort()).toEqual([3, 5]);
  });

  test('a distinct role at the same company stays separate', () => {
    // 1+2 are near-identical (cluster); 3 is far from the seed → its own row.
    const clusters = clusterDuplicates([
      item(1, 'acme', 0),
      item(2, 'acme', 0.01),
      item(3, 'acme', 0.6), // cosine to seed ≈ 0.825 < 0.95
    ]);
    expect(clusters).toEqual([{ canonicalId: 1, duplicateIds: [2] }]);
  });

  test('singletons and empty input produce no clusters', () => {
    expect(clusterDuplicates([])).toEqual([]);
    expect(clusterDuplicates([item(1, 'acme', 0)])).toEqual([]);
  });

  test('two separate duplicate pairs in one company group', () => {
    // 1+2 cluster near θ=0; 3+4 cluster near θ=π/2 (far from the first seed).
    const clusters = clusterDuplicates([
      item(1, 'acme', 0),
      item(2, 'acme', 0.01),
      item(3, 'acme', Math.PI / 2),
      item(4, 'acme', Math.PI / 2 + 0.01),
    ]);
    expect(clusters).toContainEqual({ canonicalId: 1, duplicateIds: [2] });
    expect(clusters).toContainEqual({ canonicalId: 3, duplicateIds: [4] });
    expect(clusters).toHaveLength(2);
  });

  test('threshold is configurable', () => {
    const items = [item(1, 'acme', 0), item(2, 'acme', 0.3)]; // cosine ≈ 0.955
    expect(clusterDuplicates(items, DEFAULT_DEDUP_THRESHOLD)).toEqual([
      { canonicalId: 1, duplicateIds: [2] },
    ]);
    expect(clusterDuplicates(items, 0.99)).toEqual([]);
  });

  test('a triaged row wins canonical over a higher-priority untriaged row', () => {
    const clusters = clusterDuplicates([
      item(1, 'acme', 0, /* priority */ 5, /* triaged */ false),
      item(2, 'acme', 0.01, /* priority */ 0, /* triaged */ true),
    ]);
    expect(clusters).toEqual([{ canonicalId: 2, duplicateIds: [1] }]);
  });

  test('a triaged row is never folded away as a duplicate, even as the lower-priority near-identical match', () => {
    const clusters = clusterDuplicates([
      item(10, 'acme', 0, 2, false), // untriaged canonical
      item(50, 'acme', 0.001, 2, true), // triaged, cosine ~1 to id 10
    ]);
    // id 50 must NOT appear as anyone's duplicate.
    for (const c of clusters) expect(c.duplicateIds).not.toContain(50);
  });

  test('two near-identical triaged rows both stay standalone (neither folds into the other)', () => {
    const clusters = clusterDuplicates([
      item(1, 'acme', 0, 0, true),
      item(2, 'acme', 0.001, 0, true),
    ]);
    expect(clusters).toEqual([]);
  });
});
