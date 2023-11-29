import { getDefaultAppState } from "./appState";
import { AppStateChange, ElementsChange } from "./change";
import { deepCopyElement } from "./element/newElement";
import { ExcalidrawElement } from "./element/types";
import { Emitter } from "./emitter";
import { AppState } from "./types";
import { isShallowEqual } from "./utils";

const getObservedAppState = (appState: AppState) => {
  return {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElement: appState.editingLinearElement,
  };
};

export interface IStore {
  capture(elements: Map<string, ExcalidrawElement>, appState: AppState): void;
  listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ): ReturnType<Emitter["on"]>;
  clear(): void;
}

/**
 * In the future, Store should coordinate the changes and maintain its increments cohesive between different instances.
 */
export class Store implements IStore {
  // TODO: Add a specific increment type which could be a squash of multiple changes
  private readonly onStoreIncrementEmitter = new Emitter<
    [elementsChange: ElementsChange, appStateChange: AppStateChange]
  >();

  private recordingChanges: boolean = true;
  private onlyUpdateSnapshot: boolean = false;

  private snapshot = Snapshot.empty();

  // Suspicious that this is called so many places. Seems error-prone.
  public resumeRecording() {
    this.recordingChanges = true;
  }

  public skipChangesCalculation() {
    this.onlyUpdateSnapshot = true;
  }

  public listen(
    callback: (
      elementsChange: ElementsChange,
      appStateChange: AppStateChange,
    ) => void,
  ) {
    return this.onStoreIncrementEmitter.on(callback);
  }

  public capture(
    elements: Map<string, ExcalidrawElement>,
    appState: AppState,
  ): void {
    // Quick exit for irrelevant changes
    if (!this.recordingChanges && !this.onlyUpdateSnapshot) {
      return;
    }

    // Efficiently clone the store snapshot
    const nextSnapshot = this.snapshot.clone(elements, appState);

    // Optimisation, don't continue if nothing has changed
    if (this.snapshot !== nextSnapshot) {
      // Calculate and record the changes based on the previous and next snapshot
      if (this.recordingChanges && !this.onlyUpdateSnapshot) {
        const elementsChange = nextSnapshot.didElementsChange
          ? ElementsChange.calculate(
              this.snapshot.elements,
              nextSnapshot.elements,
            )
          : ElementsChange.empty();

        const appStateChange = nextSnapshot.didAppStateChange
          ? AppStateChange.calculate(
              this.snapshot.appState,
              nextSnapshot.appState,
            )
          : AppStateChange.empty();

        if (!elementsChange.isEmpty() || !appStateChange.isEmpty()) {
          this.onStoreIncrementEmitter.trigger(elementsChange, appStateChange);
        }
      }

      this.snapshot = nextSnapshot;
    }

    // Update the snapshot
    this.recordingChanges = false;
    this.onlyUpdateSnapshot = false;
  }

  public clear(): void {
    this.snapshot = Snapshot.empty();
  }

  public destroy(): void {
    this.clear();
    this.onStoreIncrementEmitter.destroy();
  }
}

class Snapshot {
  public get didElementsChange() {
    return this.meta.didElementsChange;
  }

  public get didAppStateChange() {
    return this.meta.didAppStateChange;
  }

  private constructor(
    public readonly elements: Map<string, ExcalidrawElement>,
    public readonly appState: ReturnType<typeof getObservedAppState>,
    public readonly meta: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
    } = { didElementsChange: false, didAppStateChange: false },
  ) {}

  public static empty() {
    return new Snapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
    );
  }

  /**
   * Efficiently clone the existing snapshot.
   *
   * @returns same instance if there are no changes detected, new Snapshot instance otherwise.
   */
  public clone(
    nextElements: Map<string, ExcalidrawElement>,
    nextAppState: AppState,
  ) {
    // Not storing everything, just history relevant props
    const nextAppStateSnapshot = getObservedAppState(nextAppState);
    const didElementsChange = this.detectChangedElements(nextElements);
    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    // Nothing has changed, so there is no point of continuing further
    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    // Clone only if there was really a change
    let nextElementsSnapshot = this.elements;
    if (didElementsChange) {
      nextElementsSnapshot = this.createElementsSnapshot(nextElements);
    }

    const snapshot = new Snapshot(nextElementsSnapshot, nextAppStateSnapshot, {
      didElementsChange,
      didAppStateChange,
    });

    return snapshot;
  }

  private detectChangedAppState(
    nextAppState: ReturnType<typeof getObservedAppState>,
  ) {
    // TODO: editingLinearElement?
    return !isShallowEqual(this.appState, nextAppState, {
      selectedElementIds: isShallowEqual,
      selectedGroupIds: isShallowEqual,
    });
  }

  // TODO: could I use scene.versionNonce?
  private detectChangedElements(nextElements: Map<string, ExcalidrawElement>) {
    if (this.elements.size !== nextElements.size) {
      return true;
    }

    // loop from right to left as changes are likelier to happen on new elements
    const keys = Array.from(nextElements.keys());

    for (let i = keys.length - 1; i >= 0; i--) {
      const prev = this.elements.get(keys[i]);
      const next = nextElements.get(keys[i]);
      if (
        !prev ||
        !next ||
        prev.id !== next.id ||
        prev.versionNonce !== next.versionNonce
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Perform structural clone, cloning only elements that changed.
   */
  private createElementsSnapshot(nextElements: Map<string, ExcalidrawElement>) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements.entries()) {
      // clone previous elements, never delete, in case nextElements would be just a subset (i.e. collab)
      clonedElements.set(id, prevElement);
    }

    for (const [id, nextElement] of nextElements.entries()) {
      const prevElement = clonedElements.get(id);

      if (
        !prevElement || // element was added
        (prevElement && prevElement.versionNonce !== nextElement.versionNonce) // element was updated
      ) {
        clonedElements.set(id, deepCopyElement(nextElement));
      }
    }

    return clonedElements;
  }
}
