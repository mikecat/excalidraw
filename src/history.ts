import { AppState } from "./types";
import { ExcalidrawElement } from "./element/types";
import { getDefaultAppState } from "./appState";
import { arrayToMap, cloneJSON, isShallowEqual } from "./utils";

class History {
  private recording: boolean = true;
  private capturing: boolean = false;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  // TODO: I might not need this if the logic is inside the updater
  private historySnapshot = HistorySnapshot.empty();

  constructor() {
    this.historySnapshot
  }

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.historySnapshot = HistorySnapshot.empty();
  }

  // Suspicious that this is called so many places. Seems error-prone.
  public resumeRecording() {
    this.recording = true;
  }

  // Capture history snapshot, but don't create a history entry
  // (unless recording is `true`, which captures snapshot on its own already)
  public captureSnapshot() {
    this.capturing = true;
  }

  // TODO: stored delta might not have any effect, so we might need to iterate through the stack
  public undoOnce(): HistoryEntry | null {
    if (!this.undoStack.length) {
      return null;
    }

    const undoEntry = this.undoStack.pop();

    if (undoEntry !== undefined) {
      const redoEntry = undoEntry.inverse(this.historySnapshot);
      this.redoStack.push(redoEntry);

      return undoEntry;
    }

    return null;
  }

  // TODO: unclear if having both like this is correct
  public redoOnce(): HistoryEntry | null {
    if (!this.redoStack.length) {
      return null;
    }

    const redoEntry = this.redoStack.pop();

    if (redoEntry !== undefined) {
      const undoEntry = redoEntry.inverse(this.historySnapshot);
      this.undoStack.push(undoEntry);

      return redoEntry;
    }

    return null;
  }

  /**
   * Record a local change which will go into the history
   * Record passed elements regardless of origin, so we could calculate a diff
   */
  // TODO: should this happen in requestIdleCallback or no need?
  public record(nextAppState: AppState, nextElements: readonly ExcalidrawElement[]) {
    // Optimisation, continue only if we are recording or capturing
    if (!this.recording && !this.capturing) {
      return;
    }

    // Optimisation, don't continue if no change detected compared to last snapshot
    if (
      !didElementsChange(this.historySnapshot.elements, nextElements)
      && !didAppStateChange(this.historySnapshot.appState, nextAppState)
    ) {
      return;
    }

    // TODO: remove unnecessary properties before cloning
    // TODO: think about faster way to do this (- faster / cheaper clone / cache)
    // Cloning due to potential mutations, as we are calculating history entries out of the latest local snapshot
    const nextHistorySnapshot = HistorySnapshot.create(
      cloneJSON(clearAppStatePropertiesForHistory(nextAppState)),
      cloneJSON(nextElements),
    );

    // Only create history entry if we are recording
    if (this.recording) {
      const nextEntry = HistoryEntry.create(
        this.historySnapshot,
        nextHistorySnapshot
      );

      if (this.shouldCreateEntry(nextEntry)) {
        this.undoStack.push(nextEntry);

        // TODO: this does not have to be true, we can keep it longer
        // As a new entry was pushed, we invalidate the redo stack
        // this.clearRedoStack();

        this.recording = false;
      }
    }

    // Here capture the snapshot no matter what, we are either recording or capturing anyways
    this.historySnapshot = nextHistorySnapshot;
    this.capturing = false;
  }

  private clearRedoStack() {
    this.redoStack.length = 0;
  }

  private shouldCreateEntry(nextEntry: HistoryEntry): boolean {
    // AppState changed!
    if (Object.keys(nextEntry.deltaAppState).length) {
      return true;
    }

    if (Object.keys(nextEntry.deltaElements).length) {
      return true;
    }

    return false;
  }
}

class HistorySnapshot {
  private constructor(
    public readonly appState: ReturnType<typeof clearAppStatePropertiesForHistory>,
    public readonly elements: readonly ExcalidrawElement[] = [],
  ) { }

  public static empty() {
    return new HistorySnapshot(
      clearAppStatePropertiesForHistory(<any>getDefaultAppState()), // TODO: fix
    );
  }

  public static create(
    appState: ReturnType<typeof clearAppStatePropertiesForHistory>,
    elements: readonly ExcalidrawElement[],
  ) {
    return new HistorySnapshot(appState, elements);
  }
}

export class HistoryEntry {
  constructor(
    // TODO: would be nicer to have really just delta
    public readonly deltaAppState: Partial<ReturnType<typeof clearAppStatePropertiesForHistory>>,
    public readonly deltaElements: Map<ExcalidrawElement["id"], Partial<ExcalidrawElement>>,
  ) { }

  public static create(
    prevState: HistorySnapshot,
    nextState: HistorySnapshot,
  ) {
    return new HistoryEntry(
      createInversedAppStateDelta(prevState.appState, nextState.appState),
      createInversedElementsDeltas(prevState.elements, nextState.elements),
    )
  }

  public inverse(state: HistorySnapshot) {
    const inversedElementDeltas = new Map();

    const prevElementsMap = arrayToMap(state.elements);

    // inverse elements deltas
    for (const [id, delta] of this.deltaElements) {
      const prevElement = prevElementsMap.get(id);

      if (!prevElement) {
        // element was added => inverse is deletion
        inversedElementDeltas.set(id, { isDeleted: true });
        continue;
      }

      const previousProperties = Object.values(prevElement);
      const inversedProperties = Object.keys(delta)
        .reduce((acc, key) => {
          acc[key] = prevElement[key];
          return acc;
        }, {});

      inversedElementDeltas.set(id, { ...previousProperties, ...inversedProperties })
    }

    // inverse appstate delta
    const inversedAppStateDelta = Object.keys(this.deltaAppState)
      .reduce((acc, key) => {
        acc[key] = state.appState[key]
        return acc;
      }, {})

    return new HistoryEntry(
      inversedAppStateDelta,
      inversedElementDeltas
    )
  }
};

export default History;

const clearAppStatePropertiesForHistory = (appState: AppState) => {
  return {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElement: appState.editingLinearElement,
  };
};

// TODO utils, maybe they deserve it's own place
function didElementsChange(
  prevElements: readonly ExcalidrawElement[],
  nextElements: readonly ExcalidrawElement[],
) {
  if (prevElements.length !== nextElements.length) {
    return true;
  }

  // loop from right to left as changes are likelier to happen on new elements
  for (let i = nextElements.length - 1; i > -1; i--) {
    const prev = prevElements[i];
    const next = nextElements[i];
    if (
      !prev ||
      !next ||
      prev.id !== next.id ||
      prev.versionNonce !== next.versionNonce
    ) {
      return true;
    }
  }
}

function didAppStateChange(
  prevState: ReturnType<typeof clearAppStatePropertiesForHistory>,
  nextAppState: ReturnType<typeof clearAppStatePropertiesForHistory>,
) {
  // TODO: linearElementEditor? potentially others?
  return !isShallowEqual(prevState, nextAppState, {
    selectedElementIds: isShallowEqual,
    selectedGroupIds: isShallowEqual,
  })
}

// TODO: Get away from static functions
function createInversedAppStateDelta(
  prevAppState: ReturnType<typeof clearAppStatePropertiesForHistory>,
  nextAppState: ReturnType<typeof clearAppStatePropertiesForHistory>,
) {
  return __unsafe__inversedDeltasGenerator(prevAppState, nextAppState);
}

function createInversedElementsDeltas(
  prevElements: readonly ExcalidrawElement[],
  nextElements: readonly ExcalidrawElement[],
) {
  // TODO: Strip it from version, versionNonce and potentially other useless metadata
  const inversedDeltas: Map<ExcalidrawElement["id"], Partial<ExcalidrawElement>> = new Map();

  // Optimizing for hot path
  if (!didElementsChange(prevElements, nextElements)) {
    return inversedDeltas;
  }

  const prevElementsMap = arrayToMap(prevElements);

  for (const element of nextElements) {
    const cachedElement = prevElementsMap.get(element.id);

    if (!cachedElement) {
      // element was added => inverse is deletion
      inversedDeltas.set(element.id, { isDeleted: true });
      continue;
    }

    if (cachedElement.versionNonce !== element.versionNonce) {
      // element was updated (including "soft" deletion) => inverse are previous values of modified properties
      const elementDelta = __unsafe__inversedDeltasGenerator(cachedElement, element);
      inversedDeltas.set(element.id, elementDelta);
    }
  }

  return inversedDeltas;
}

// TODO: Let's test this boy first, probably doesn't cover all edge cases
// TODO: also add some generic typing
function __unsafe__inversedDeltasGenerator(prevAppState: any, nextAppState: any) {
  const inversedDelta = {};

  for (const key of Object.keys(nextAppState)) {
    if (prevAppState[key] !== nextAppState[key]) {
      if (typeof nextAppState[key] !== "object") {
        inversedDelta[key] = prevAppState[key];
        continue;
      }

      // Both are object but one of them is null, so they couldn't be shallow compared
      if (nextAppState[key] !== null || prevAppState[key] !== null) {
        inversedDelta[key] = prevAppState[key];
        continue;
      }

      if (!isShallowEqual(prevAppState[key], nextAppState[key])) {
        inversedDelta[key] = prevAppState[key];
        continue;
      }
    }
  }

  return inversedDelta;
}


// TODO: still needed?
// if (
//         isLinearElement(element) &&
//         appState.multiElement &&
//         appState.multiElement.id === element.id
//       ) {
//         // don't store multi-point arrow if still has only one point
//         if (
//           appState.multiElement &&
//           appState.multiElement.id === element.id &&
//           element.points.length < 2
//         ) {
//           return elements;
//         }

//         elements.push({
//           ...element,
//           // don't store last point if not committed
//           points:
//             element.lastCommittedPoint !==
//               element.points[element.points.length - 1]
//               ? element.points.slice(0, -1)
//               : element.points,
//         });
//       } else {
//         elements.push(element);
//       }
//       return elements

// const { prevEntry } = this;

// // TODO: is this still needed?
// if (!prevEntry) {
//   return true;
// }

// TODO: still needed?
// // note: this is safe because entry's appState is guaranteed no excess props
// let key: keyof typeof nextEntry.deltaAppState;
// for (key in nextEntry.deltaAppState) {
//   if (key === "editingLinearElement") {
//     if (
//       nextEntry.appState[key]?.elementId ===
//       prevEntry.appState[key]?.elementId
//     ) {
//       continue;
//     }
//   }
//   if (key === "selectedElementIds" || key === "selectedGroupIds") {
//     continue;
//   }
//   if (nextEntry.appState[key] !== prevEntry.appState[key]) {
//     return true;
//   }
// }

// TODO: check if this still makes sense
/**
 * Updates history's `lastEntry` to latest app state. This is necessary
 *  when doing undo/redo which itself doesn't commit to history, but updates
 *  app state in a way that would break `shouldCreateEntry` which relies on
 *  `lastEntry` to reflect last comittable history state.
 * We can't update `lastEntry` from within history when calling undo/redo
 *  because the action potentially mutates appState/elements before storing
 *  it.
 */
// public setCurrentState(nextAppState: AppState, nextElements: readonly ExcalidrawElement[]) {

// }
