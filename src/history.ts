import { AppStateChange, ElementsChange } from "./change";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";

export class History {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];

  // TODO: think about limiting the depth
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

  public undoOnce(
    elements: Map<string, ExcalidrawElement>,
  ): HistoryEntry | null {
    if (!this.undoStack.length) {
      return null;
    }

    const undoEntry = this.undoStack.pop();

    if (undoEntry !== undefined) {
      const redoEntry = undoEntry.inverse().applyLatestChanges(elements);
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
      const undoEntry = redoEntry.inverse().applyLatestChanges(elements);
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
  ): HistoryEntry {
    const updatedElementsChange =
      this.elementsChange.applyLatestChanges(elements);

    return HistoryEntry.create(this.appStateChange, updatedElementsChange);
  }

  public isEmpty(): boolean {
    return this.appStateChange.isEmpty() && this.elementsChange.isEmpty();
  }
}