import { AppState } from "./types";
import { ExcalidrawElement } from "./element/types";
import { getDefaultAppState } from "./appState";
import { arrayToMap, cloneJSON, isShallowEqual } from "./utils";
import { ObjectChange, ElementsChange } from "./change";

function clearDeltaElementProperties(element: Partial<ExcalidrawElement>) {
  const { updated, version, versionNonce, ...strippedElement } = element;
  return strippedElement;
}

const clearAppStateProperties = (appState: AppState) => {
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
    public readonly appStateChange: ObjectChange<
      ReturnType<typeof clearAppStateProperties>
    >,
    public readonly elementsChange: ElementsChange<
      ReturnType<typeof clearDeltaElementProperties>
    >,
  ) {}

  public static create(prevState: HistorySnapshot, nextState: HistorySnapshot) {
    // TODO: Do this only on detected change
    const appStateChange = ObjectChange.calculate(
      prevState.appState,
      nextState.appState,
    );

    // TODO: Do this only on detected change
    const elementsChange = ElementsChange.calculate(
      arrayToMap(prevState.elements),
      arrayToMap(nextState.elements),
      clearDeltaElementProperties,
    );

    return new HistoryEntry(appStateChange.inverse(), elementsChange.inverse());
  }

  public inverse(): HistoryEntry {
    return new HistoryEntry(
      this.appStateChange.inverse(),
      this.elementsChange.inverse(),
    );
  }

  public isEmpty(): boolean {
    return this.appStateChange.isEmpty() && this.elementsChange.isEmpty();
  }
}

class HistorySnapshot {
  private constructor(
    public readonly appState: ReturnType<typeof clearAppStateProperties>,
    public readonly elements: readonly ExcalidrawElement[] = [],
  ) {}

  public static empty() {
    return new HistorySnapshot(
      clearAppStateProperties(getDefaultAppState() as any), // TODO: fix
    );
  }

  public static create(
    appState: ReturnType<typeof clearAppStateProperties>,
    elements: readonly ExcalidrawElement[],
  ) {
    return new HistorySnapshot(appState, elements);
  }

  public didChange(
    nextAppState: ReturnType<typeof clearAppStateProperties>,
    nextElements: readonly ExcalidrawElement[],
  ) {
    return (
      this.didAppStateChange(nextAppState) ||
      this.didElementsChange(nextElements)
    );
  }

  private didAppStateChange(
    nextAppState: ReturnType<typeof clearAppStateProperties>,
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

  // TODO: unclear if having both like this is correct, we might need to update it based on latest content
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
    const nextHistoryAppState = clearAppStateProperties(nextAppState);
    if (!this.historySnapshot.didChange(nextHistoryAppState, nextElements)) {
      return;
    }

    // TODO: think about a better way to do this faster / cheaper clone / cache)
    // Cloning due to potential mutations, as we are calculating history entries out of the latest local snapshot
    const nextHistorySnapshot = HistorySnapshot.create(
      cloneJSON(nextHistoryAppState),
      cloneJSON(nextElements),
    );

    // Only create history entry if we are recording
    if (this.recording) {
      const nextEntry = HistoryEntry.create(
        this.historySnapshot,
        nextHistorySnapshot,
      );

      if (!nextEntry.isEmpty()) {
        this.undoStack.push(nextEntry);

        // As a new entry was pushed, we invalidate the redo stack
        this.clearRedoStack();
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
}

export default History;

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
