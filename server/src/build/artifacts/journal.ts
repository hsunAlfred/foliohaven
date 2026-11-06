import { BuildResultSchema, UuidSchema } from '@foliohaven/core';
import type { BuildResult, RecoveryResolution } from '@foliohaven/core';
import { record } from '../../files/io.js';
import { ArtifactError, parseArtifactManifest } from './tree.js';
import type { ArtifactManifest } from './types.js';

export interface ArtifactJournal {
  schemaVersion: 1;
  id: string;
  sequence: number;
  kind: 'build' | 'resolution';
  createdAt: string;
  status:
    | 'prepared'
    | 'switching'
    | 'committed'
    | 'rolled-back'
    | 'recovery-required'
    | 'resolved';
  base: ArtifactManifest | null;
  prepared: ArtifactManifest | null;
  /** 舊紀錄可缺欄；null 明確表示不能證明來源，不能依 digest 猜測。 */
  baseBuildId?: string | null;
  preparedBuildId?: string | null;
  result: BuildResult;
  artifactCommittedAt: string | null;
  temporaryDiscarded?: true;
  resolution?: {
    choice: 'keep-current' | 'restore-backup' | 'apply-prepared';
    expectedDigest: string | null;
    childId?: string;
    revisions: RecoveryResolution['revisions'];
  };
}
export interface ArtifactState {
  schemaVersion: 1;
  sequence: number;
  currentSequence: number;
  currentJournalId: string | null;
  acceptedDigest: string | null;
}
export const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(): never {
  throw new ArtifactError(
    'BUILD_RECOVERY_REQUIRED',
    '建置提交紀錄無法判讀，請保留所有復原資料。',
  );
}
export function parseArtifactJournal(value: unknown): ArtifactJournal {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !UuidSchema.safeParse(value.id).success ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) <= 0 ||
    !['build', 'resolution'].includes(String(value.kind)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    ![
      'prepared',
      'switching',
      'committed',
      'rolled-back',
      'recovery-required',
      'resolved',
    ].includes(String(value.status)) ||
    !(
      value.artifactCommittedAt === null ||
      (typeof value.artifactCommittedAt === 'string' &&
        Number.isFinite(Date.parse(value.artifactCommittedAt)))
    )
  )
    fail();
  const base = value.base === null ? null : parseArtifactManifest(value.base);
  const prepared =
    value.prepared === null ? null : parseArtifactManifest(value.prepared);
  const parsedResult = BuildResultSchema.safeParse(value.result);
  if (
    !parsedResult.success ||
    (value.kind === 'build' && prepared === null) ||
    parsedResult.data.fileCount !== (prepared?.fileCount ?? 0)
  )
    fail();
  for (const key of ['baseBuildId', 'preparedBuildId'] as const)
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !UuidSchema.safeParse(value[key]).success
    )
      fail();
  if (
    (value.baseBuildId != null &&
      (base === null || value.baseBuildId === value.id)) ||
    (value.preparedBuildId != null && prepared === null) ||
    (value.kind === 'build' &&
      value.preparedBuildId !== undefined &&
      value.preparedBuildId !== value.id) ||
    (value.kind === 'resolution' && value.preparedBuildId === value.id)
  )
    fail();
  if (value.resolution !== undefined) {
    const decision = value.resolution;
    if (
      !record(decision) ||
      !['keep-current', 'restore-backup', 'apply-prepared'].includes(
        String(decision.choice),
      ) ||
      !(
        decision.expectedDigest === null || isDigest(decision.expectedDigest)
      ) ||
      (decision.childId !== undefined &&
        !UuidSchema.safeParse(decision.childId).success) ||
      !Array.isArray(decision.revisions) ||
      decision.revisions.length === 0 ||
      decision.revisions.some(
        (item: unknown) =>
          !record(item) ||
          typeof item.resourceKey !== 'string' ||
          !(
            item.resourceKey === 'dist' || /^dist\/.+/.test(item.resourceKey)
          ) ||
          !(item.revision === null || isDigest(item.revision)),
      )
    )
      fail();
  }
  if (
    value.temporaryDiscarded !== undefined &&
    (value.temporaryDiscarded !== true ||
      value.status !== 'rolled-back' ||
      value.artifactCommittedAt !== null)
  )
    fail();
  return {
    ...value,
    base,
    prepared,
    result: parsedResult.data,
  } as unknown as ArtifactJournal;
}
export function parseArtifactState(value: unknown): ArtifactState {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !Number.isSafeInteger(value.currentSequence) ||
    Number(value.currentSequence) < 0 ||
    Number(value.currentSequence) > Number(value.sequence) ||
    !(
      value.currentJournalId === null ||
      UuidSchema.safeParse(value.currentJournalId).success
    ) ||
    !(value.acceptedDigest === null || isDigest(value.acceptedDigest))
  )
    fail();
  return value as unknown as ArtifactState;
}
