import { AppState } from "./types";
import { ExcalidrawElement } from "./element/types";
import { getDefaultAppState } from "./appState";
import { arrayToMap, cloneJSON, isShallowEqual } from "./utils";
import { AppStateChange, ElementsChange } from "./change";

function clearElementPropertiesForHistory(element: ExcalidrawElement) {
  const { updated, version, versionNonce, ...strippedElement } = element;
  return strippedElement;
}

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

export class HistoryEntry {
  private constructor(
    public readonly appStateChange: AppStateChange<
      ReturnType<typeof clearAppStatePropertiesForHistory>
    >,
    public readonly elementsChange: ElementsChange<
      ExcalidrawElement["id"],
      Partial<ReturnType<typeof clearElementPropertiesForHistory>>
    >,
  ) {}

  public static create(prevState: HistorySnapshot, nextState: HistorySnapshot) {
    const appStateChange = AppStateChange.calculate(
      prevState.appState,
      nextState.appState,
    );
    const elementsChange = ElementsChange.calculate(
      arrayToMap(prevState.elements),
      arrayToMap(nextState.elements),
    );

    // TODO: strip away version, versionNonce and etc.
    return new HistoryEntry(appStateChange.inverse(), elementsChange.inverse());
  }

  public inverse(): HistoryEntry {
    return new HistoryEntry(
      this.appStateChange.inverse(),
      this.elementsChange.inverse(),
    );
  }
}

class HistorySnapshot {
  private constructor(
    public readonly appState: ReturnType<
      typeof clearAppStatePropertiesForHistory
    >,
    public readonly elements: readonly ExcalidrawElement[] = [],
  ) {}

  public static empty() {
    return new HistorySnapshot(
      clearAppStatePropertiesForHistory(getDefaultAppState() as any), // TODO: fix
    );
  }

  public static create(
    appState: ReturnType<typeof clearAppStatePropertiesForHistory>,
    elements: readonly ExcalidrawElement[],
  ) {
    return new HistorySnapshot(appState, elements);
  }

  public didChange(
    nextAppState: ReturnType<typeof clearAppStatePropertiesForHistory>,
    nextElements: readonly ExcalidrawElement[],
  ) {
    return (
      this.didAppStateChange(nextAppState) ||
      this.didElementsChange(nextElements)
    );
  }

  private didAppStateChange(
    nextAppState: ReturnType<typeof clearAppStatePropertiesForHistory>,
  ) {
    // TODO: linearElementEditor? potentially others?
    return !isShallowEqual(this.appState, nextAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  private didElementsChange(nextElements: readonly ExcalidrawElement[]) {
    if (this.elements.length !== nextElements.length) {
      return true;
    }

    // loop from right to left as changes are likelier to happen on new elements
    for (let i = nextElements.length - 1; i > -1; i--) {
      const prev = this.elements[i];
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
}

class History {
  private recording: boolean = true;
  private capturing: boolean = false;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  // TODO: I might not need this if the logic is inside the updater
  private historySnapshot = HistorySnapshot.empty();

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
      // TODO: is this correct? Ideally I should inverse it after applying it
      const redoEntry = undoEntry.inverse();
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
      const undoEntry = redoEntry.inverse();
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
  public record(
    nextAppState: AppState,
    nextElements: readonly ExcalidrawElement[],
  ) {
    // Optimisation, continue only if we are recording or capturing
    if (!this.recording && !this.capturing) {
      return;
    }

    // Optimisation, don't continue if no change detected compared to last snapshot
    const nextHistoryAppState = clearAppStatePropertiesForHistory(nextAppState);
    if (!this.historySnapshot.didChange(nextHistoryAppState, nextElements)) {
      return;
    }

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
        nextHistorySnapshot,
      );

      if (this.shouldCreateEntry(nextEntry)) {
        this.undoStack.push(nextEntry);

        // As a new entry was pushed, we invalidate the redo stack
        // this.clearRedoStack();
      }

      this.recording = false;
    }

    // Here capture the snapshot no matter what, we are either recording or capturing anyways
    this.historySnapshot = nextHistorySnapshot;
    this.capturing = false;
  }

  private clearRedoStack() {
    this.redoStack.length = 0;
  }

  private shouldCreateEntry(nextEntry: HistoryEntry): boolean {
    if (!nextEntry.appStateChange.isEmpty()) {
      return true;
    }

    if (!nextEntry.elementsChange.isEmpty()) {
      return true;
    }

    return false;
  }
}

export default History;

// public inverse(state: HistorySnapshot) {
//   const inversedElementDeltas = new Map();

//   const prevElementsMap = arrayToMap(state.elements);
//   // inverse elements deltas
//   for (const [id, delta] of this.elementsChange) {
//     const prevElement = prevElementsMap.get(id);

//     if (!prevElement) {
//       // element was added => inverse is deletion
//       inversedElementDeltas.set(id, { ...delta, isDeleted: true });
//       continue;
//     }

//     const inversedProperties = Object.keys(delta).reduce((acc, key) => {
//       acc[key] = prevElement[key];
//       return acc;
//     }, {});

//     inversedElementDeltas.set(id, {
//       ...prevElement,
//       ...inversedProperties,
//     });
//   }

//   // inverse appstate delta
//   // move to a util
//   const inversedAppStateDelta = Object.keys(this.appStateChange).reduce(
//     (acc, key) => {
//       acc[key] = state.appState[key];
//       return acc;
//     },
//     {},
//   );

//   return new HistoryEntry(inversedAppStateDelta, inversedElementDeltas);
// }

// type ElementDelta = ReturnType<typeof omitIrrelevantElementDeltaProps>;

// const omitIrrelevantElementDeltaProps = (delta: Partial<ExcalidrawElement>) => {
//   const {
//     id,
//     version,
//     versionNonce,
//     updated,
//     ...strippedDelta
//   } = delta;

//   return strippedDelta
// }

// function createInversedElementsDeltas(
//   prevElements: readonly ExcalidrawElement[],
//   nextElements: readonly ExcalidrawElement[],
// ) {
//   // TODO: Strip it from version, versionNonce and potentially other useless metadata
//   const inversedDeltas: Map<
//     ExcalidrawElement["id"],
//     Partial<ExcalidrawElement>
//   > = new Map();

//   // Optimizing for hot path
//   if (!didElementsChange(prevElements, nextElements)) {
//     return inversedDeltas;
//   }

//   const prevElementsMap = arrayToMap(prevElements);

//   for (const element of nextElements) {
//     const cachedElement = prevElementsMap.get(element.id);

//     if (!cachedElement) {
//       // element was added => inverse is deletion
//       inversedDeltas.set(element.id, { isDeleted: true });
//       continue;
//     }

//     if (cachedElement.versionNonce !== element.versionNonce) {
//       const strippedElement = clearElementPropertiesForHistory(element);
//       // element was updated (including "soft" deletion) => inverse are previous values of modified properties
//       const elementDelta = __unsafe__inversedDeltasGenerator(
//         cachedElement,
//         strippedElement,
//       );
//       inversedDeltas.set(element.id, elementDelta);
//     }
//   }

//   return inversedDeltas;
// }

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
