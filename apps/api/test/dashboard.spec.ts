import { describe, expect, it } from 'vitest';
import { DashboardService } from './src/dashboard/dashboard.service';

describe('DashboardService', () => {
  it('returns deterministic Pencil-shaped payload', () => {
    const dto = new DashboardService().get();
    expect(dto.kpis).toHaveLength(6);
    expect(dto.weekly).toHaveLength(7);
    expect(dto.stages.length).toBeGreaterThan(0);
    expect(dto.activity.length).toBeGreaterThan(0);
    expect(dto.source).toBe('seed');
  });
});
