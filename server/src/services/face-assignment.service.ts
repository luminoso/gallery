import { Transaction } from 'kysely';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FaceIdentityRepository } from 'src/repositories/face-identity.repository.js';
import { FacePersonVerdictRepository } from 'src/repositories/face-person-verdict.repository.js';
import { FaceRepairDeclineRepository } from 'src/repositories/face-repair-decline.repository.js';
import { FaceRepairRepository } from 'src/repositories/face-repair.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { VerdictMaps, VerdictTarget, isSettledForOwner, targetTokens } from 'src/utils/face-repair.js';

export interface FaceAssignmentServiceDependencies {
  databaseRepository: DatabaseRepository;
  faceIdentityRepository: FaceIdentityRepository;
  facePersonVerdictRepository: FacePersonVerdictRepository;
  faceRepairDeclineRepository: FaceRepairDeclineRepository;
  faceRepairRepository: FaceRepairRepository;
  personRepository: PersonRepository;
}

export interface AssignFacesInput {
  personGroupId: string;
  faceIds: string[];
  // `manual` is a human placement: the durable lock no scan questions. `owner-person` is an ordinary one.
  strength: 'manual' | 'owner-person';
  // Omitted: move the faces unconditionally (a user's explicit reassignment). Set: move only the faces still
  // on `from` (and ML-sourced, visible), the cleanup engine's write-time guard against a concurrent move since
  // it planned. `from === personGroupId` re-affirms faces where they already sit.
  from?: string;
}

// Plain class (not @Injectable, not a repository), built once in BaseService's constructor and shared as
// `this.faceAssignmentService`, the same cross-service-sharing pattern IdentityMergePropagationService uses.
//
// It owns both sides of "face F belongs to person P": the write (assignFaces, the one placement sequence every
// personal path goes through) and the read (settlement: has a human already decided F for P). Both key on
// the same tables and the same target tokens, so they live together.
export class FaceAssignmentService {
  constructor(private deps: FaceAssignmentServiceDependencies) {}

  // "These faces now belong to this person." The face moves, its identity link is re-pointed at the person
  // with the given strength, every still-pending suggestion for it drains, and any rejected/ignored verdict
  // against THIS person is cleared (the newer human decision wins; a verdict against a different person
  // survives). All of it commits together: a face on the new person still carrying the old identity is the
  // torn state FaceIdentityBackfill resolves back to the old person, silently reverting the move (D14).
  //
  // Joins the caller's transaction when given one (e.g. a suggestion claim that must roll back with it),
  // otherwise opens its own. Returns the ids actually assigned. Feature photos stay the caller's follow-up:
  // only the caller knows whose representative face it just took away.
  async assignFaces(input: AssignFacesInput, trx?: Transaction<DB>): Promise<string[]> {
    if (input.faceIds.length === 0) {
      return [];
    }
    if (!trx) {
      return this.deps.databaseRepository.transaction((trx) => this.assignFaces(input, trx));
    }

    const { personGroupId, from, strength } = input;
    let faceIds = input.faceIds;
    if (from === undefined) {
      for (const faceId of faceIds) {
        await this.deps.personRepository.reassignFace(faceId, personGroupId, trx);
      }
    } else if (from !== personGroupId) {
      faceIds = await this.deps.faceRepairRepository.reattributeFaces(from, personGroupId, faceIds, trx);
      if (faceIds.length === 0) {
        return [];
      }
    }

    const identity = await this.deps.faceIdentityRepository.ensurePersonIdentity(personGroupId, trx);
    // `requirePersonId` re-checks placement inside this transaction, so only a face actually on the person is
    // re-linked, drained and cleared (H5). It is the only guard for the in-place case.
    faceIds = await this.deps.faceIdentityRepository.replaceFaceIdentities(
      { assetFaceIds: faceIds, identityId: identity.id, source: strength, requirePersonId: personGroupId },
      trx,
    );
    await this.deps.facePersonVerdictRepository.drainPendingForFaces(faceIds, trx);
    await this.deps.facePersonVerdictRepository.clearNegativeForTarget(
      { personGroupId, identityId: identity.id },
      faceIds,
      trx,
    );
    return faceIds;
  }

  // Which of these faces a human has already settled for this target: placed anywhere (a manual identity
  // link, owner-agnostic), or said "not this person/identity" about. The same predicate the cleanup engine
  // applies (isSettledForOwner over targetTokens). claimPending's eligibility gate is its SQL twin, pinned
  // equal by test/medium/specs/services/face-assignment.service.spec.ts.
  async getSettledFaceIds(assetFaceIds: string[], target: VerdictTarget): Promise<Set<string>> {
    const unique = [...new Set(assetFaceIds)];
    if (unique.length === 0) {
      return new Set();
    }
    const [manualLinkedFaceIds, negativeFaceTargets] = await Promise.all([
      this.deps.faceIdentityRepository.getManualLinkedFaceIds(unique),
      this.deps.facePersonVerdictRepository.getNegativeVerdictTokens(unique),
    ]);
    const ownerTokens = new Map([['target', targetTokens(target)]]);
    return new Set(
      unique.filter((assetFaceId) =>
        isSettledForOwner(
          { assetFaceId, suspectedOwnerId: 'target' },
          { manualLinkedFaceIds, negativeFaceTargets, ownerTokens },
        ),
      ),
    );
  }

  // The cleanup engine's exclusion inputs for a bounded set of flagged faces. Every source is scoped to the
  // ids the scan actually produced, never an unscoped table read.
  async buildVerdictMaps(scope: {
    assetFaceIds: string[];
    personIds: string[];
    suspectedOwnerIds: string[];
  }): Promise<VerdictMaps> {
    const uniqueFaceIds = [...new Set(scope.assetFaceIds)];
    const uniqueOwnerIds = [...new Set(scope.suspectedOwnerIds)];

    const [manualLinkedFaceIds, negativeFaceTargets, ownerTokens, mutedPersons] = await Promise.all([
      this.deps.faceIdentityRepository.getManualLinkedFaceIds(uniqueFaceIds),
      this.deps.facePersonVerdictRepository.getNegativeVerdictTokens(uniqueFaceIds),
      this.deps.faceIdentityRepository.getPersonVerdictTokens(uniqueOwnerIds),
      this.deps.faceRepairDeclineRepository.getClusterMuteMap(scope.personIds),
    ]);

    return { manualLinkedFaceIds, negativeFaceTargets, ownerTokens, mutedPersons };
  }
}
