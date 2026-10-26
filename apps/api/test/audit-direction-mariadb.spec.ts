import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditLogsService } from '../src/audit/audit-logs.service';
import type { AuthPrincipal } from '../src/auth/auth-principal';

const db = process.env.EDO_TEST_DATABASE_URL ?? '';
if (db && !/^mysql:\/\/[^@/]+@127\.0\.0\.1:(3307|3308)\/edo(?:\?|$)/.test(db))
  throw new Error('Disposable audit test database required');
const prefix = `audit-direction-${randomUUID()}`;
const ids = {ru:`${prefix}-r`,ig:`${prefix}-i`,employee:`${prefix}-e`,ruDoc:`${prefix}-d1`,igDoc:`${prefix}-d2`,fixed:`${prefix}-d3`};
const actor = `audit-${randomUUID()}`;
const principal = (accessRules: Record<string,string[]>): AuthPrincipal => ({uuid:actor,code1c:null,sid:null,deviceId:null,expiresAt:null,accessRules});

describe.skipIf(!db)('real SQL audit direction and independent location scope',()=>{
  let prisma: PrismaService, service: AuditLogsService;
  beforeAll(async()=>{
    prisma = new PrismaService({datasources:{db:{url:db}}}); await prisma.$connect();
    service = new AuditLogsService(prisma);
    await prisma.candidate.createMany({data:[
      {id:ids.ru,identityKey:ids.ru,reviewGroup:'RU',citizenship:'uz',locationId:null},
      {id:ids.ig,identityKey:ids.ig,reviewGroup:'IG',citizenship:'ru',chatUuid:randomUUID(),locationId:null},
    ]});
    await prisma.employee.create({data:{id:ids.employee,fullName:'Synthetic case',locationId:777}});
    await prisma.document.createMany({data:[
      {id:ids.ruDoc,candidateId:ids.ru,reviewGroup:'RU'},
      {id:ids.igDoc,candidateId:ids.ig,reviewGroup:'IG'},
      {id:ids.fixed,candidateId:ids.ru,reviewGroup:'IG'},
    ]});
    await prisma.auditLog.createMany({data:[
      ...[ids.ruDoc,ids.igDoc,ids.fixed].map(entityId=>({actorId:actor,action:'DOCUMENT_APPROVED' as const,entityType:'Document',entityId})),
      {actorId:actor,action:'EMPLOYEE_CREATED',entityType:'Employee',entityId:ids.employee},
    ]});
  });
  afterAll(async()=>{
    if (!prisma) return;
    await prisma.auditLog.deleteMany({where:{actorId:actor}});
    await prisma.document.deleteMany({where:{id:{in:[ids.ruDoc,ids.igDoc,ids.fixed]}}});
    await prisma.candidate.deleteMany({where:{id:{in:[ids.ru,ids.ig]}}});
    await prisma.employee.deleteMany({where:{id:ids.employee}}); await prisma.$disconnect();
  });
  it('RU history is global without object grants and ignores citizenship',async()=>{
    const result = await service.list(principal({'20002':[]}),{mine:true,limit:100});
    expect(result.items.map(row=>row.entityId)).toEqual([ids.ruDoc]);
  });
  it('IG history stays IG with a chat and uses the saved document direction',async()=>{
    const result = await service.list(principal({'20011':[]}),{mine:true,limit:100});
    expect(result.items.map(row=>row.entityId).sort()).toEqual([ids.igDoc,ids.fixed].sort());
  });
  it('a reviewer cannot probe history of another direction',async()=>{
    expect((await service.list(principal({'20002':[]}),{entityType:'Document',entityId:ids.igDoc})).items).toEqual([]);
    expect((await service.list(principal({'20011':[]}),{entityType:'Document',entityId:ids.igDoc})).items).toHaveLength(1);
  });
  it('review rights do not widen employee history; object scope still applies',async()=>{
    const result = await service.list(principal({'20002':[],'20007':['777']}),{mine:true,limit:100});
    expect(result.items.map(row=>row.entityId).sort()).toEqual([ids.ruDoc,ids.employee].sort());
    expect((await service.list(principal({'20005':[]}),{limit:100})).items).toEqual([]);
    expect((await service.list(principal({'20005':[],'20007':['777']}),{entityType:'Employee',entityId:ids.employee})).items).toHaveLength(1);
  });
});
