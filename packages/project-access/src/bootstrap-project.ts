import { hashIngestionKey } from './ingestion-keys.ts';
export interface InitialProjectInput {
  principalId: string;
  issuer: string;
  subject: string;
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  keyId: string;
  keyName: string;
  publicKey: string;
}
export function createInitialProjectStatement(input: InitialProjectInput): {
  text: string;
  values: readonly string[];
} {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid initial project input');
  for (const value of [input.principalId, input.organizationId, input.projectId, input.keyId])
    if (
      typeof value !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    )
      throw new TypeError('Invalid bootstrap UUID');
  for (const value of [
    input.issuer,
    input.subject,
    input.organizationName,
    input.projectName,
    input.keyName,
  ])
    if (
      typeof value !== 'string' ||
      !/\S/.test(value) ||
      value.includes('\0') ||
      Buffer.from(value).toString() !== value ||
      Buffer.byteLength(value) > 1024
    )
      throw new TypeError('Invalid bootstrap text');
  for (const value of [input.organizationName, input.projectName, input.keyName])
    if ([...value].length > 200) throw new TypeError('Bootstrap name exceeds limit');
  return {
    text: `WITH principal AS (
INSERT INTO signaltrail_control.principals(id,issuer,subject) VALUES ($1::uuid,$2,$3) RETURNING id
), organization AS (
INSERT INTO signaltrail_control.organizations(id,name) VALUES ($4::uuid,$5) RETURNING id
), project AS (
INSERT INTO signaltrail_control.projects(id,organization_id,name)
SELECT $6::uuid,id,$7 FROM organization RETURNING id
), membership AS (
INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role)
SELECT organization.id,principal.id,'owner' FROM organization CROSS JOIN principal RETURNING organization_id
), ingestion_key AS (
INSERT INTO signaltrail_control.ingestion_keys(id,project_id,name,key_hash)
SELECT $8::uuid,id,$9,decode($10,'hex') FROM project RETURNING project_id
)
SELECT project.id::text AS project_id FROM project CROSS JOIN membership CROSS JOIN ingestion_key`,
    values: [
      input.principalId,
      input.issuer,
      input.subject,
      input.organizationId,
      input.organizationName,
      input.projectId,
      input.projectName,
      input.keyId,
      input.keyName,
      hashIngestionKey(input.publicKey),
    ],
  };
}
