import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Category, Prisma, Status } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type { ChatActor } from './chatbot.identity';
import { CIVICLOOP_GUIDE } from './chatbot.knowledge';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    'Use a real YYYY-MM-DD date',
  );
const argumentsByTool = {
  get_product_guide: z.object({}).strict(),
  search_my_complaints: z
    .object({
      query: z.string().trim().max(120).optional(),
      status: z.enum(Status).optional(),
      category: z.enum(Category).optional(),
      offset: z.number().int().min(0).max(100).default(0),
      limit: z.number().int().min(1).max(5).default(5),
    })
    .strict(),
  get_my_complaint: z.object({ complaintId: z.string().uuid() }).strict(),
  list_wards: z
    .object({
      query: z.string().trim().max(80).optional(),
      offset: z.number().int().min(0).max(1000).default(0),
    })
    .strict(),
  get_ward_performance: z
    .object({
      wardIds: z.array(z.string().uuid()).min(1).max(4),
      period: z
        .enum(['all_time', 'last_7_days', 'last_30_days', 'last_90_days'])
        .default('last_30_days'),
      startDate: date.optional(),
      endDate: date.optional(),
    })
    .strict(),
} as const;
const descriptions: Record<keyof typeof argumentsByTool, string> = {
  get_product_guide:
    'Retrieve reviewed CivicLoop usage instructions. Use for how-to and role questions; contains no live complaint or ward figures.',
  search_my_complaints:
    'Retrieve up to 5 reports created by the authenticated user, newest first. Optional title search/category/status. Never accepts another user ID. Requires sign-in. Includes safe status facts, not free-text descriptions or personal information.',
  get_my_complaint:
    'Retrieve the current status and recent event types/dates of one report owned by the authenticated user. Requires sign-in. Unknown and other-owner IDs are indistinguishable.',
  list_wards:
    'Find up to 10 wards by name in the configured CivicLoop city. Use their exact IDs for performance/comparison. Resolve ambiguous names rather than guessing.',
  get_ward_performance:
    'Compare up to 4 wards using the same complaint-creation cohort: rolling 30 days by default, other rolling periods or all_time. Optional startDate/endDate selects inclusive UTC calendar dates instead. Counts exclude linked duplicate reports. Returns current resolved/verified, pending, reopened and ever-escalated counts and resolution rate; not speed, deadline compliance or causal effectiveness.',
};

export const CHATBOT_TOOLS = Object.entries(argumentsByTool).map(
  ([name, schema]) => {
    const parameters = z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
    });
    delete parameters.$schema;
    return {
      type: 'function',
      function: {
        name,
        description: descriptions[name as keyof typeof argumentsByTool],
        parameters,
      },
    };
  },
);

export interface ChatSource {
  id: string;
  label: string;
  href: string;
  retrievedAt: string;
  scope: 'personal' | 'public';
  facts: Array<{ label: string; value: string }>;
}
type RetrievalResult = { data: unknown; source?: Omit<ChatSource, 'id'> };
const complaintFields = {
  id: true,
  category: true,
  currentStatus: true,
  createdAt: true,
  ward: { select: { id: true, name: true } },
  department: { select: { name: true } },
} satisfies Prisma.ComplaintSelect;

@Injectable()
export class ChatbotRetrieval {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async execute(
    name: string,
    raw: unknown,
    actor?: ChatActor,
  ): Promise<RetrievalResult> {
    if (!Object.hasOwn(argumentsByTool, name))
      return { data: { error: 'tool_not_allowed' } };
    const key = name as keyof typeof argumentsByTool;
    const args = argumentsByTool[key].safeParse(raw);
    if (!args.success)
      return {
        data: {
          error: 'invalid_arguments',
          message: 'Use only the documented arguments and limits.',
        },
      };
    if (
      (key === 'search_my_complaints' || key === 'get_my_complaint') &&
      !actor
    )
      return {
        data: {
          error: 'sign_in_required',
          message: 'Sign in to retrieve your own reports.',
        },
      };
    const now = new Date();
    const city = this.config.get<string>('CITY_CODE') ?? 'pilot-city';
    const source = (
      label: string,
      href: string,
      scope: 'personal' | 'public',
      facts: ChatSource['facts'],
    ) => ({ label, href, scope, retrievedAt: now.toISOString(), facts });
    switch (key) {
      case 'get_product_guide':
        return {
          data: { guide: CIVICLOOP_GUIDE },
          source: source('CivicLoop product guide', '/report', 'public', [
            {
              label: 'Coverage',
              value: 'Reporting, tracking, sign-in and roles',
            },
          ]),
        };
      case 'search_my_complaints': {
        const input = argumentsByTool.search_my_complaints.parse(raw);
        const reports = await this.prisma.complaint.findMany({
          where: {
            createdById: actor!.id,
            ...(input.query
              ? { title: { contains: input.query, mode: 'insensitive' } }
              : {}),
            ...(input.status ? { currentStatus: input.status } : {}),
            ...(input.category ? { category: input.category } : {}),
          },
          select: complaintFields,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: input.offset,
          take: input.limit + 1,
        });
        const items = reports.slice(0, input.limit);
        return {
          data: {
            reports: items,
            hasMore: reports.length > input.limit,
            nextOffset: input.offset + items.length,
          },
          source: source(
            'My complaint statuses',
            '/profile',
            'personal',
            items.length
              ? items.map((c) => ({
                  label: `${c.category} · ${c.ward.name} · ${c.id.slice(0, 8)}`,
                  value: c.currentStatus.replaceAll('_', ' '),
                }))
              : [
                  {
                    label: 'Results',
                    value: 'No matching reports found in your account.',
                  },
                ],
          ),
        };
      }
      case 'get_my_complaint': {
        const input = argumentsByTool.get_my_complaint.parse(raw);
        const report = await this.prisma.complaint.findFirst({
          where: { id: input.complaintId, createdById: actor!.id },
          select: {
            ...complaintFields,
            events: {
              select: { type: true, createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 8,
            },
          },
        });
        if (!report)
          return {
            data: {
              error: 'report_not_available',
              message: 'No matching report is available in your account.',
            },
          };
        return {
          data: { report },
          source: source(
            'Complaint status and recent timeline',
            `/complaints/${report.id}`,
            'personal',
            [
              {
                label: `${report.category} · ${report.ward.name}`,
                value: report.currentStatus.replaceAll('_', ' '),
              },
              ...report.events.map((e) => ({
                label: e.type.replaceAll('_', ' '),
                value: e.createdAt.toISOString(),
              })),
            ],
          ),
        };
      }
      case 'list_wards': {
        const input = argumentsByTool.list_wards.parse(raw);
        const wards = await this.prisma.ward.findMany({
          where: {
            cityCode: city,
            ...(input.query
              ? { name: { contains: input.query, mode: 'insensitive' } }
              : {}),
          },
          select: { id: true, name: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: input.offset,
          take: 11,
        });
        return {
          data: { city, wards: wards.slice(0, 10), hasMore: wards.length > 10 },
          source: source(
            'Ward directory',
            '/map',
            'public',
            wards.length
              ? wards.slice(0, 10).map((w) => ({ label: w.name, value: city }))
              : [
                  {
                    label: 'Results',
                    value: 'No matching wards in this city.',
                  },
                ],
          ),
        };
      }
      case 'get_ward_performance': {
        const input = argumentsByTool.get_ward_performance.parse(raw);
        const ids = [...new Set(input.wardIds)];
        let start: Date | undefined;
        let end = now;
        if (input.startDate || input.endDate) {
          if (!input.startDate || !input.endDate)
            return {
              data: {
                error: 'invalid_period',
                message: 'Provide both UTC startDate and endDate.',
              },
            };
          start = new Date(input.startDate);
          end = new Date(Date.parse(input.endDate) + 86400000);
          if (
            start >= end ||
            start > now ||
            end.getTime() - start.getTime() > 366 * 86400000
          )
            return {
              data: {
                error: 'invalid_period',
                message:
                  'Use an ordered interval of at most 366 days, starting no later than today.',
              },
            };
          if (end > now) end = now;
        } else if (input.period !== 'all_time') {
          const days = { last_7_days: 7, last_30_days: 30, last_90_days: 90 }[
            input.period
          ];
          start = new Date(now.getTime() - days * 86400000);
        }
        return this.prisma.$transaction(
          async (tx) => {
            const wards = await tx.ward.findMany({
              where: { id: { in: ids }, cityCode: city },
              select: { id: true, name: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
            });
            if (wards.length !== ids.length)
              return {
                data: {
                  error: 'wards_not_available',
                  message: 'Choose wards returned by list_wards in this city.',
                },
              };
            const where: Prisma.ComplaintWhereInput = {
              wardId: { in: ids },
              duplicateOfId: null,
              createdAt: { ...(start ? { gte: start } : {}), lt: end },
            };
            const counts = await tx.complaint.groupBy({
              by: ['wardId', 'currentStatus'],
              where,
              _count: { _all: true },
            });
            const escalations = await tx.complaint.groupBy({
              by: ['wardId'],
              where: { ...where, events: { some: { type: 'ESCALATED' } } },
              _count: { _all: true },
            });
            const metrics = wards.map((w) => {
              const rows = counts.filter((c) => c.wardId === w.id);
              const total = rows.reduce((sum, c) => sum + c._count._all, 0);
              const resolved = rows
                .filter(
                  (c) =>
                    c.currentStatus === Status.RESOLVED ||
                    c.currentStatus === Status.VERIFIED,
                )
                .reduce((sum, c) => sum + c._count._all, 0);
              const reopened =
                rows.find((c) => c.currentStatus === Status.REOPENED)?._count
                  ._all ?? 0;
              const escalated =
                escalations.find((c) => c.wardId === w.id)?._count._all ?? 0;
              return {
                ...w,
                total,
                resolved,
                pending: total - resolved,
                reopened,
                everEscalated: escalated,
                resolutionRate: total
                  ? Math.round((resolved / total) * 1000) / 10
                  : null,
              };
            });
            const period = {
              fromInclusive: start?.toISOString() ?? null,
              toExclusive: end.toISOString(),
              basis:
                'Complaints created in this interval; statuses as of retrieval. Linked duplicates excluded. Ever-escalated counts are not SLA compliance or current overdue counts.',
            };
            return {
              data: { city, period, wards: metrics },
              source: source('Ward performance comparison', '/map', 'public', [
                {
                  label: 'Reporting period (UTC)',
                  value: `${start?.toISOString() ?? 'All history'} → ${end.toISOString()}`,
                },
                ...metrics.map((w) => ({
                  label: w.name,
                  value: `${w.resolved}/${w.total} resolved (${w.resolutionRate === null ? 'no reports' : `${w.resolutionRate}%`}); ${w.pending} pending, ${w.reopened} reopened, ${w.everEscalated} ever escalated`,
                })),
              ]),
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            maxWait: 2000,
            timeout: 5000,
          },
        );
      }
    }
  }
}
