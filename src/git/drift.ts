// src/git/drift.ts

/** Offline inputs for classifying a single unit's drift. */
export interface DriftInputs {
  /** The unit's current local tip SHA. */
  localTip: string;
  /** SHA sp sync last pushed for this unit (PR cache); undefined if unknown. */
  syncedHeadSha?: string;
  /** Remote-tracking tip SHA; undefined if the tracking ref is absent. */
  remoteTrackingTip?: string;
}

/** Two independent, orthogonal drift signals. */
export interface Drift {
  /** Local tip differs from the last pushed SHA (only when that SHA is known). */
  localAhead: boolean;
  /** Local tip differs from the remote-tracking tip (only when it is known). */
  remoteAhead: boolean;
}

/**
 * Pure: classify a unit's drift from offline inputs. An unknown reference point
 * (undefined) yields `false` for its signal — we never render a marker we can't
 * justify.
 */
export function classifyDrift(inputs: DriftInputs): Drift {
  const { localTip, syncedHeadSha, remoteTrackingTip } = inputs;
  return {
    localAhead: syncedHeadSha !== undefined && localTip !== syncedHeadSha,
    remoteAhead: remoteTrackingTip !== undefined && localTip !== remoteTrackingTip,
  };
}
