import { AppStateChange, ElementsChange } from "./change";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";

export class History {
  // TODO: think about limiting the depth
  // TODO: when stacks are empty, disable the buttons
  // TODO: we might want to persist the history locally (follow-up)
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  public get isUndoStackEmpty() {
    return this.undoStack.length === 0;
  }

  public get isRedoStackEmpty() {
    return this.redoStack.length === 0;
  }

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  // TODO: stored delta might not have any effect (i.e. because they were performed on delete items)
  //, so we might need to iterate through the stack
  public undoOnce(
    elements: Map<string, ExcalidrawElement>,
  ): HistoryEntry | null {
    if (!this.undoStack.length) {
      return null;
    }

    const undoEntry = this.undoStack.pop();

    if (undoEntry !== undefined) {
      // TODO: update the redo based on the existing snapshot
      const redoEntry = undoEntry.inverse().applyLatestChanges(elements, "to");
      this.redoStack.push(redoEntry);

      return undoEntry;
    }

    return null;
  }

  public redoOnce(
    elements: Map<string, ExcalidrawElement>,
  ): HistoryEntry | null {
    if (!this.redoStack.length) {
      return null;
    }

    const redoEntry = this.redoStack.pop();

    if (redoEntry !== undefined) {
      const undoEntry = redoEntry.inverse().applyLatestChanges(elements, "to");
      this.undoStack.push(undoEntry);
      return redoEntry;
    }

    return null;
  }

  /**
   * Record a local change which will go into the history
   * Record passed elements regardless of origin, so we could calculate a diff
   */
  public record(
    elementsChange: ElementsChange,
    appStateChange: AppStateChange,
  ) {
    const nextEntry = HistoryEntry.create(
      appStateChange.inverse(),
      elementsChange.inverse(),
    );

    if (!nextEntry.isEmpty()) {
      this.undoStack.push(nextEntry);

      // As a new entry was pushed, we invalidate the redo stack
      this.redoStack.length = 0;
    }
  }
}

export class HistoryEntry {
  private constructor(
    public readonly appStateChange: AppStateChange,
    public readonly elementsChange: ElementsChange,
  ) {}

  public static create(
    appStateChange: AppStateChange,
    elementsChange: ElementsChange,
  ) {
    return new HistoryEntry(appStateChange, elementsChange);
  }

  public inverse(): HistoryEntry {
    return new HistoryEntry(
      this.appStateChange.inverse(),
      this.elementsChange.inverse(),
    );
  }

  public applyTo(
    elements: Map<string, ExcalidrawElement>,
    appState: AppState,
  ): [[Map<string, ExcalidrawElement>, boolean], [AppState, boolean]] {
    // TODO: just keep the map once we have fractional indices
    // TODO: apply z-index deltas differently
    const nextElements = this.elementsChange.applyTo(elements);
    const nextAppState = this.appStateChange.applyTo(appState);

    return [nextElements, nextAppState];
  }

  /**
   * Apply latest (remote) changes to the history entry, creates new instance of `HistoryEntry`.
   */
  public applyLatestChanges(
    elements: Map<string, ExcalidrawElement>,
    modifierOptions: "from" | "to",
  ): HistoryEntry {
    const updatedElementsChange = this.elementsChange.applyLatestChanges(
      elements,
      modifierOptions,
    );

    return HistoryEntry.create(this.appStateChange, updatedElementsChange);
  }

  public isEmpty(): boolean {
    return this.appStateChange.isEmpty() && this.elementsChange.isEmpty();
  }
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
// setCurrentState(appState: AppState, elements: readonly ExcalidrawElement[]) {
//   this.lastEntry = this.hydrateHistoryEntry(
//     this.generateEntry(appState, elements),
//   );
// }
