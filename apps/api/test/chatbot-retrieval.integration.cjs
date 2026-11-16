// Requires pnpm install, prisma generate, API build, and local Docker.
// Creates/removes its own PostgreSQL container. Never uses an existing DATABASE_URL.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const { ChatbotRetrieval } = require('../dist/src/chatbot/chatbot.retrieval');

async function withFixture(check) {
  const name = `civicloop-chat-test-${randomBytes(5).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const database = 'civicloop_chat_test';
  const image =
    'postgres:16-alpine@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663';
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD',
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      '127.0.0.1::5432',
      image,
    ],
    {
      env: { ...process.env, POSTGRES_PASSWORD: password },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let prisma;
  try {
    const port = execFileSync('docker', ['port', name, '5432'], {
      encoding: 'utf8',
    })
      .trim()
      .split(':')
      .at(-1);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
          stdio: 'ignore',
        });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert(ready, 'Disposable PostgreSQL must become ready');
    const ddl = execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema-datamodel',
        path.resolve(__dirname, '../prisma/schema.prisma'),
        '--script',
      ],
      { encoding: 'utf8' },
    );
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        database,
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { input: ddl, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`,
        },
      },
    });
    const ids = Object.fromEntries(
      [
        'ownerA',
        'ownerB',
        'wardA',
        'wardB',
        'emptyWard',
        'otherCity',
        'department',
        'resolved',
        'reopened',
        'pending',
        'old',
        'duplicate',
      ].map((key) => [key, randomUUID()]),
    );
    await prisma.user.createMany({
      data: [
        {
          id: ids.ownerA,
          name: 'PRIVATE_NAME_CANARY',
          email: 'private-canary@example.invalid',
          password: 'PRIVATE_PASSWORD_CANARY',
        },
        { id: ids.ownerB },
      ],
    });
    await prisma.ward.createMany({
      data: [
        { id: ids.wardA, name: 'Ward A', cityCode: 'test-city' },
        { id: ids.wardB, name: 'Ward B', cityCode: 'test-city' },
        { id: ids.emptyWard, name: 'Empty Ward', cityCode: 'test-city' },
        { id: ids.otherCity, name: 'Ward A', cityCode: 'other-city' },
      ],
    });
    await prisma.department.create({
      data: { id: ids.department, name: 'Roads', code: 'TEST_ROADS' },
    });
    const ago = (days) => new Date(Date.now() - days * 86400000);
    const report = (id, user, ward, status, days) => ({
      id,
      createdById: user,
      wardId: ward,
      departmentId: ids.department,
      title: 'PRIVATE_TITLE_CANARY',
      description: 'PRIVATE_DESCRIPTION_CANARY',
      category: 'ROAD',
      lat: 10,
      lng: 20,
      currentStatus: status,
      createdAt: ago(days),
    });
    await prisma.complaint.createMany({
      data: [
        report(ids.resolved, ids.ownerA, ids.wardA, 'RESOLVED', 5),
        report(ids.reopened, ids.ownerB, ids.wardA, 'REOPENED', 1),
        report(ids.pending, ids.ownerA, ids.wardB, 'INSPECTION', 3),
        report(ids.old, ids.ownerB, ids.wardB, 'VERIFIED', 100),
      ],
    });
    await prisma.complaint.create({
      data: {
        ...report(ids.duplicate, ids.ownerA, ids.wardA, 'RESOLVED', 1),
        duplicateOfId: ids.resolved,
      },
    });
    await prisma.complaintEvent.createMany({
      data: [1, 2].map((index) => ({
        complaintId: ids.reopened,
        type: 'ESCALATED',
        data: { note: 'PRIVATE_EVENT_CANARY' },
        hash: `escalation-${index}`,
        createdAt: ago(0.5),
      })),
    });
    await check({ prisma, ids });
  } finally {
    if (prisma) await prisma.$disconnect();
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

async function verify({ prisma, ids }) {
  const retrieval = new ChatbotRetrieval(
    prisma,
    new ConfigService({ CITY_CODE: 'test-city' }),
  );
  const actor = { id: ids.ownerA, role: 'ADMIN' };
  const own = await retrieval.execute('search_my_complaints', {}, actor);
  assert.deepEqual(
    new Set(own.data.reports.map((r) => r.id)),
    new Set([ids.resolved, ids.pending, ids.duplicate]),
  );
  assert(!JSON.stringify(own).includes('PRIVATE_'));
  const missing = await retrieval.execute(
    'get_my_complaint',
    { complaintId: randomUUID() },
    actor,
  );
  const another = await retrieval.execute(
    'get_my_complaint',
    { complaintId: ids.reopened },
    actor,
  );
  assert.deepEqual(another, missing);
  assert.equal(
    (await retrieval.execute('search_my_complaints', {})).data.error,
    'sign_in_required',
  );
  assert.equal(
    (
      await retrieval.execute(
        'search_my_complaints',
        { userId: ids.ownerB },
        actor,
      )
    ).data.error,
    'invalid_arguments',
  );
  console.log(
    'PASS: real PostgreSQL ownership, staff isolation, sign-in requirement and sensitive-field exclusion',
  );

  const compare = await retrieval.execute('get_ward_performance', {
    wardIds: [ids.wardA, ids.wardB, ids.emptyWard],
  });
  const a = compare.data.wards.find((w) => w.id === ids.wardA);
  const b = compare.data.wards.find((w) => w.id === ids.wardB);
  const empty = compare.data.wards.find((w) => w.id === ids.emptyWard);
  assert.deepEqual(
    {
      total: a.total,
      resolved: a.resolved,
      pending: a.pending,
      reopened: a.reopened,
      escalated: a.everEscalated,
      rate: a.resolutionRate,
    },
    { total: 2, resolved: 1, pending: 1, reopened: 1, escalated: 1, rate: 50 },
  );
  assert.equal(b.total, 1);
  assert.equal(b.resolutionRate, 0);
  assert.equal(empty.resolutionRate, null);
  assert(!JSON.stringify(compare).includes('PRIVATE_'));
  const all = await retrieval.execute('get_ward_performance', {
    wardIds: [ids.wardB],
    period: 'all_time',
  });
  assert.equal(all.data.wards[0].resolutionRate, 50);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const interval = await retrieval.execute('get_ward_performance', {
    wardIds: [ids.wardA],
    startDate: yesterday,
    endDate: today,
  });
  assert.equal(interval.data.wards[0].total, 1);
  assert.equal(
    (
      await retrieval.execute('get_ward_performance', {
        wardIds: [ids.otherCity],
      })
    ).data.error,
    'wards_not_available',
  );
  console.log(
    'PASS: common cohort, duplicate exclusion, distinct escalation counts, custom dates, null empty-ward rates and city isolation',
  );

  await prisma.complaint.update({
    where: { id: ids.resolved },
    data: { currentStatus: 'WORK_IN_PROGRESS' },
  });
  const changed = await retrieval.execute(
    'get_my_complaint',
    { complaintId: ids.resolved },
    actor,
  );
  assert.equal(changed.data.report.currentStatus, 'WORK_IN_PROGRESS');
  assert(!JSON.stringify(changed).includes('PRIVATE_'));
  console.log(
    'PASS: live status changes are retrieved again without stale cache',
  );
}

module.exports = { withFixture };
if (require.main === module)
  withFixture(verify).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
