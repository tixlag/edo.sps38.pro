import { describe, expect, it } from 'vitest';
import { KPI_META } from './DashboardPage';

describe('Dashboard KPI transitions (KPI_META.to)', () => {
  it('queue leads to the /review document queue it counts', () => {
    expect(KPI_META.queue.to).toBe('/review');
  });

  it('in_review (employee cases) is not clickable: /employees has no status filter, /review is a document queue', () => {
    expect(KPI_META.in_review.to).toBeUndefined();
  });

  it('rework leads to the /review queue (same document scope as the KPI), never to mine-only /history', () => {
    expect(KPI_META.rework.to).toBe('/review');
  });

  it('no KPI links to /history (a 20002 reviewer sees only own actions there, KPIs count every in-scope row)', () => {
    for (const [key, meta] of Object.entries(KPI_META)) {
      expect(meta.to, key).not.toBe('/history');
    }
  });
});
