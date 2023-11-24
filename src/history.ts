import { AppState } from "./types";
import { ExcalidrawElement } from "./element/types";
import { getDefaultAppState } from "./appState";
import { cloneJSON, isShallowEqual } from "./utils";
import { AppStateIncrement, ElementsIncrement } from "./change";
import { deepCopyElement } from "./element/newElement";

function clearElementProperties(element: Partial<ExcalidrawElement>) {
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
    public readonly appStateChange: AppStateIncrement,
    public readonly elementsChange: ElementsIncrement,
  ) {}

  public static create(prevState: HistorySnapshot, nextState: HistorySnapshot) {
    // TODO: Do this only on detected change
    const appStateChange = AppStateIncrement.calculate(
      prevState.appState,
      nextState.appState,
    );

    // TODO: Do this only on detected change
    const elementsChange = ElementsIncrement.calculate(
      prevState.elements,
      nextState.elements,
      clearElementProperties,
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
    public readonly elements: Map<string, ExcalidrawElement> = new Map(),
  ) {}

  public static empty() {
    return new HistorySnapshot(
      clearAppStateProperties(getDefaultAppState() as any), // TODO: fix
    );
  }

  public static create(
    appState: ReturnType<typeof clearAppStateProperties>,
    elements: Map<string, ExcalidrawElement>,
  ) {
    return new HistorySnapshot(appState, elements);
  }

  public didAppStateChange(
    nextAppState: ReturnType<typeof clearAppStateProperties>,
  ) {
    // TODO: linearElementEditor? potentially others?
    return !isShallowEqual(this.appState, nextAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  public didElementsChange(nextElements: Map<string, ExcalidrawElement>) {
    if (this.elements.size !== nextElements.size) {
      return true;
    }

    // loop from right to left as changes are likelier to happen on new elements
    const keys = Array.from(nextElements.keys()).reverse();

    for (const key of keys) {
      const prev = this.elements.get(key);
      const next = nextElements.get(key);
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

  public elementsStructuralClone(nextElements: Map<string, ExcalidrawElement>) {
    const clonedElements = new Map();

    // Assign existing elements
    for (const [id, element] of this.elements.entries()) {
      clonedElements.set(id, element);
    }

    // Update cloned elements
    for (const [id, nextElement] of nextElements.entries()) {
      const element = clonedElements.get(id);

      if (
        !element ||
        (element && element.versionNonce !== nextElement.versionNonce)
      ) {
        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}

class History {
  private recording: boolean = true;
  private capturing: boolean = false;

  // TODO: limit empty commands
  // TODO: think on what limit to put in both
  // TODO: when empty, disable the buttons
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

  // Capture history snapshot, but don't record a history entry
  // (unless recording is `true`, which captures snapshot on its own already)
  public resumeCapturing() {
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
    nextElements: Map<string, ExcalidrawElement>,
  ) {
    // Continue only if we are recording or capturing
    if (!this.recording && !this.capturing) {
      return;
    }

    // TODO: should encapsulate a bit

    // Not storing everything, just history relevant props
    const nextHistoryAppState = clearAppStateProperties(nextAppState);
    const appStateChanged =
      this.historySnapshot.didAppStateChange(nextHistoryAppState);

    const elementsChanged =
      this.historySnapshot.didElementsChange(nextElements);

    // Nothing has changed, so there is no point of continuing further
    if (!appStateChanged && !elementsChanged) {
      return;
    }

    // Optimisations, clone again only if there was really a change
    let nextHistoryElements = this.historySnapshot.elements;
    if (elementsChanged) {
      // I do not clone, just update in situ
      nextHistoryElements =
        this.historySnapshot.elementsStructuralClone(nextElements);
    }

    const nextHistorySnapshot = HistorySnapshot.create(
      nextHistoryAppState,
      nextHistoryElements,
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
// setCurrentState(appState: AppState, elements: readonly ExcalidrawElement[]) {
//   this.lastEntry = this.hydrateHistoryEntry(
//     this.generateEntry(appState, elements),
//   );
// }
