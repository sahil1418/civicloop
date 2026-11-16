import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChatbotRetrieval, CHATBOT_TOOLS } from './chatbot.retrieval';

describe('Chatbot retrieval boundaries', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const actor = { id: 'owner-a', role: 'ADMIN' as const };
  const db = {
    complaint: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      groupBy: jest.fn(),
    },
    ward: { findMany: jest.fn() },
  };
  const transaction = jest.fn((fn: (tx: typeof db) => Promise<unknown>) =>
    fn(db),
  );
  const retrieval = new ChatbotRetrieval(
    { ...db, $transaction: transaction } as unknown as PrismaService,
    new ConfigService({ CITY_CODE: 'test-city' }),
  );
  beforeEach(() => {
    Object.values(db.complaint).forEach((mock) => mock.mockReset());
    db.ward.findMany.mockReset();
    transaction.mockClear();
  });

  it('has only read-only tools, rejects unknown tools and extra identity arguments before database access', async () => {
    expect(CHATBOT_TOOLS.map((t) => t.function.name)).toEqual([
      'get_product_guide',
      'search_my_complaints',
      'get_my_complaint',
      'list_wards',
      'get_ward_performance',
    ]);
    expect(await retrieval.execute('execute_sql', {}, actor)).toEqual({
      data: { error: 'tool_not_allowed' },
    });
    expect(
      await retrieval.execute(
        'search_my_complaints',
        { userId: 'other-owner' },
        actor,
      ),
    ).toMatchObject({ data: { error: 'invalid_arguments' } });
    expect(
      await retrieval.execute('get_ward_performance', {
        wardIds: [a],
        city: 'other-city',
      }),
    ).toMatchObject({ data: { error: 'invalid_arguments' } });
    expect(db.complaint.findMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('requires sign-in and enforces ownership even for staff; never selects contact information or free-text payloads', async () => {
    expect(await retrieval.execute('search_my_complaints', {})).toMatchObject({
      data: { error: 'sign_in_required' },
    });
    expect(db.complaint.findMany).not.toHaveBeenCalled();
    db.complaint.findMany.mockResolvedValue([]);
    await retrieval.execute(
      'search_my_complaints',
      { category: 'ROAD' },
      actor,
    );
    const selection = (
      db.complaint.findMany.mock.calls as unknown[][]
    )[0][0] as {
      where: unknown;
      select: Record<string, unknown>;
    };
    expect(selection.where).toEqual({
      createdById: actor.id,
      category: 'ROAD',
    });
    for (const field of [
      'description',
      'title',
      'createdBy',
      'lat',
      'lng',
      'media',
    ])
      expect(selection.select).not.toHaveProperty(field);
    db.complaint.findFirst.mockResolvedValue(null);
    const missing = await retrieval.execute(
      'get_my_complaint',
      { complaintId: a },
      actor,
    );
    expect(missing).toMatchObject({ data: { error: 'report_not_available' } });
    expect(db.complaint.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: a, createdById: actor.id } }),
    );
  });

  it('computes comparable counts, percentage and no-data rates from one repeatable-read cohort', async () => {
    db.ward.findMany.mockResolvedValue([
      { id: a, name: 'Ward A' },
      { id: b, name: 'Empty Ward' },
    ]);
    db.complaint.groupBy
      .mockResolvedValueOnce([
        { wardId: a, currentStatus: 'RESOLVED', _count: { _all: 2 } },
        { wardId: a, currentStatus: 'REOPENED', _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([{ wardId: a, _count: { _all: 1 } }]);
    const result = await retrieval.execute('get_ward_performance', {
      wardIds: [a, b],
      period: 'last_30_days',
    });
    expect(result.data).toMatchObject({
      wards: [
        {
          id: a,
          total: 3,
          resolved: 2,
          pending: 1,
          reopened: 1,
          everEscalated: 1,
          resolutionRate: 66.7,
        },
        { id: b, total: 0, resolutionRate: null },
      ],
    });
    const aggregate = (
      db.complaint.groupBy.mock.calls as unknown[][]
    )[0][0] as {
      where: {
        wardId: unknown;
        duplicateOfId: unknown;
        createdAt: { gte: Date; lt: Date };
      };
    };
    expect(aggregate.where.wardId).toEqual({ in: [a, b] });
    expect(aggregate.where.duplicateOfId).toBeNull();
    expect(aggregate.where.createdAt.gte).toBeInstanceOf(Date);
    expect(aggregate.where.createdAt.lt).toBeInstanceOf(Date);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      maxWait: 2000,
      timeout: 5000,
    });
    expect(JSON.stringify(result.source)).toContain('no reports');
  });

  it('rejects cross-city wards and invalid periods before aggregate access', async () => {
    db.ward.findMany.mockResolvedValue([]);
    expect(
      await retrieval.execute('get_ward_performance', { wardIds: [a] }),
    ).toMatchObject({ data: { error: 'wards_not_available' } });
    expect(db.ward.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [a] }, cityCode: 'test-city' },
      }),
    );
    expect(
      await retrieval.execute('get_ward_performance', {
        wardIds: [a],
        startDate: '2026-02-30',
        endDate: '2026-03-01',
      }),
    ).toMatchObject({ data: { error: 'invalid_arguments' } });
    expect(
      await retrieval.execute('get_ward_performance', {
        wardIds: [a],
        startDate: '2026-10-02',
        endDate: '2026-10-01',
      }),
    ).toMatchObject({ data: { error: 'invalid_period' } });
    expect(db.complaint.groupBy).not.toHaveBeenCalled();
  });
});
