import { describe, expect, test } from 'bun:test';
import { RESCUE_FIXTURES } from '../../scripts/fixtures/rescue-calibration';
import { l1Filter, TITLE_MISSING_REASON } from './filter';
import {
  RESCUE_MIN_QUERY_FLOOR,
  RESCUE_MIN_SIMILARITY_CENTROID,
  RESCUE_MIN_SIMILARITY_QUERY,
  RESCUE_MIN_SURVIVORS,
  centroidOf,
  chooseAnchor,
  selectRescues,
  type RescueAnchor,
} from './semantic-rescue';

const at = (sim: number) => new Float32Array([sim, Math.sqrt(1 - sim * sim)]);
const queryAnchor: RescueAnchor = { vec: new Float32Array([1, 0]), minSimilarity: 0.5, kind: 'query' };

describe('selectRescues', () => {
  const cands = [0.3, 0.9, 0.51, 0.7, 0.49].map(sim => ({ vec: at(sim), item: sim }));

  test('keeps only candidates over the anchor threshold, best first', () => {
    expect(selectRescues(queryAnchor, cands).map(r => r.item)).toEqual([0.9, 0.7, 0.51]);
  });

  test('caps the promotions before the threshold is even considered', () => {
    expect(selectRescues(queryAnchor, cands, 2).map(r => r.item)).toEqual([0.9, 0.7]);
  });

  test('nothing clears the bar, nothing is promoted', () => {
    expect(selectRescues({ ...queryAnchor, minSimilarity: 0.99 }, cands)).toEqual([]);
    expect(selectRescues(queryAnchor, [])).toEqual([]);
  });
});

describe('centroidOf / chooseAnchor', () => {
  test('the centroid is the unit-length mean', () => {
    const c = centroidOf([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  test('uses the floored centroid from the minimum survivors up, else the query vector', () => {
    const queryVec = new Float32Array([0, 1]);
    const survivors = (n: number) => Array.from({ length: n }, () => new Float32Array([1, 0]));
    const withEnough = chooseAnchor(survivors(RESCUE_MIN_SURVIVORS), queryVec);
    expect(withEnough).toMatchObject({
      kind: 'centroid',
      minSimilarity: RESCUE_MIN_SIMILARITY_CENTROID,
      queryFloor: { vec: queryVec, minSimilarity: RESCUE_MIN_QUERY_FLOOR },
    });
    expect(chooseAnchor(survivors(RESCUE_MIN_SURVIVORS - 1), queryVec)).toEqual({
      vec: queryVec,
      minSimilarity: RESCUE_MIN_SIMILARITY_QUERY,
      kind: 'query',
    });
    expect(chooseAnchor([], undefined)).toBeNull();
  });

  test('the query floor is applied before the cap, so a drifted centroid cannot fill it', () => {
    const anchor: RescueAnchor = {
      vec: new Float32Array([0, 1]), // centroid
      minSimilarity: 0.5,
      kind: 'centroid',
      queryFloor: { vec: new Float32Array([1, 0]), minSimilarity: 0.3 },
    };
    // Higher centroid similarity than the legitimate one, but far from the query.
    const offTopic = [0.99, 0.98].map(c => ({ vec: new Float32Array([Math.sqrt(1 - c * c), c]), item: `off ${c}` }));
    const onTopic = { vec: new Float32Array([0.6, 0.8]), item: 'on' };
    expect(selectRescues(anchor, [...offTopic, onTopic], 1).map(r => r.item)).toEqual(['on']);
  });
});

describe('calibration fixture', () => {
  // The threshold is calibrated on postings rescue would actually see: title-only L1
  // misses. A fixture item that L1 passes or fails for another reason would skew it.
  test('every item is a title-only L1 miss and every survivor passes the title rule', () => {
    for (const f of RESCUE_FIXTURES) {
      for (const it of f.items) {
        const r = l1Filter({ url: 'https://x.test', title: it.title, company: it.company }, f.criteria);
        expect([f.query, it.title, r.reasons]).toEqual([f.query, it.title, [TITLE_MISSING_REASON]]);
      }
      for (const s of f.survivors) {
        const r = l1Filter({ url: 'https://x.test', title: s.title, company: s.company }, f.criteria);
        expect([f.query, s.title, r.reasons]).toEqual([f.query, s.title, []]);
      }
    }
  });
});
