// GENERATED — DO NOT EDIT.
// Generated ONLY from the narrow LK EDO spec: openapi/edo.json
// (copy of lk.sps38.pro next/openapi/edo.json, version pinned in CI).
// Never generate from the full LK Swagger.

export interface EdoOrganization {
  code: string | null;
  name: string | null;
}

export interface EdoNamedCode {
  code1c: string | null;
  name: string | null;
}

export interface EdoLocationRef {
  id: number;
  code1c: string;
  name: string;
}

export interface EdoEmployee {
  code1c: string;
  uuid: string;
  fullName: string;
  birthday: string | null;
  citizenship: string | null;
  organization: EdoOrganization;
  position: EdoNamedCode;
  department: EdoNamedCode;
  division: EdoNamedCode;
  lastLocation: EdoLocationRef | null;
  hireDate: string | null;
  fired: boolean;
  contractor: boolean;
  updatedAt: string | null;
}

export interface EdoEmployeePage {
  items: EdoEmployee[];
  nextCursor: string | null;
}

export interface EdoLocation {
  id: number;
  code1c: string;
  name: string;
  shortName: string;
  generalUnitCode: string | null;
  deleted: boolean;
  updatedAt: string | null;
}

export interface EdoReference {
  code1c: string;
  name: string;
  deleted: boolean;
  updatedAt: string | null;
}
