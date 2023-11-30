import { newElementWith } from "./element/mutateElement";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";
import { isShallowEqual } from "./utils";

/**
 * Represents the difference between two `T` objects.
 *
 * Keeping it as pure object (without transient state, side-effects, etc.), so we don't have to instantiate it on load.
 */
class Delta<T> {
  private constructor(
    public readonly from: Partial<T>,
    public readonly to: Partial<T>,
  ) {}

  public static create<T>(
    from: Partial<T>,
    to: Partial<T>,
    modifier?: (delta: Partial<T>) => Partial<T>,
    modifierOptions?: "from" | "to",
  ) {
    const modifiedFrom =
      modifier && modifierOptions !== "to" ? modifier(from) : from;
    const modifiedTo =
      modifier && modifierOptions !== "from" ? modifier(to) : to;

    return new Delta(modifiedFrom, modifiedTo);
  }

  /**
   * Calculates the delta between two objects.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns new Delta instance.
   */
  public static calculate<T extends Object>(
    prevObject: T,
    nextObject: T,
    modifier?: (delta: Partial<T>) => Partial<T>,
  ): Delta<T> {
    if (prevObject === nextObject) {
      return Delta.empty();
    }

    const from = {} as Partial<T>;
    const to = {} as Partial<T>;

    const unionOfKeys = new Set([
      ...Object.keys(prevObject),
      ...Object.keys(nextObject),
    ]);

    for (const key of unionOfKeys) {
      const prevValue = prevObject[key as keyof T];
      const nextValue = nextObject[key as keyof T];

      if (prevValue !== nextValue) {
        from[key as keyof T] = prevValue;
        to[key as keyof T] = nextValue;
      }
    }
    return Delta.create(from, to, modifier);
  }

  public static empty() {
    return new Delta({}, {});
  }

  public static isEmpty<T>(delta: Delta<T>): boolean {
    return !Object.keys(delta.from).length && !Object.keys(delta.to).length;
  }

  public static containsDifference<T>(delta: Partial<T>, object: T) {
    for (const [key, deltaValue] of Object.entries(delta)) {
      const objectValue = object[key as keyof T];
      if (deltaValue !== objectValue) {
        // TODO: Worth going also shallow equal way?
        // - it means O(n^3), but this is calculated on applying the change (not a hot path)
        // - better to sort this at the root (if possible)
        if (
          typeof deltaValue === "object" &&
          typeof objectValue === "object" &&
          deltaValue !== null &&
          objectValue !== null &&
          isShallowEqual(
            deltaValue as Record<string, any>,
            objectValue as Record<string, any>,
          )
        ) {
          continue;
        }

        return true;
      }
    }

    return false;
  }
}

// TODO: I also might need a clone (with modifier)
/**
 * Encapsulates the modifications captured as `Delta`/s.
 */
interface Change<T> {
  /**
   * Inverses the `Delta`s inside while creating a new `Change`.
   */
  inverse(): Change<T>;

  /**
   * Applies the `Change` to the previous object.
   *
   * @returns new object instance and boolean, indicating if there was any visible change made.
   */
  applyTo(previous: T): [T, boolean];

  /**
   * Checks whether there are actually `Delta`s.
   */
  isEmpty(): boolean;
}

export class AppStateChange implements Change<AppState> {
  private constructor(private readonly delta: Delta<AppState>) {}

  public static calculate<T extends Partial<AppState>>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateChange {
    const delta = Delta.calculate(prevAppState, nextAppState);
    return new AppStateChange(delta);
  }

  public static empty() {
    return new AppStateChange(Delta.create({}, {}));
  }

  public inverse(): AppStateChange {
    const inversedDelta = Delta.create(this.delta.to, this.delta.from);
    return new AppStateChange(inversedDelta);
  }

  public applyTo(appState: AppState): [AppState, boolean] {
    const containsDifference = Delta.containsDifference(
      this.delta.to,
      appState,
    );

    const newAppState = {
      ...appState,
      ...this.delta.to,
    };

    return [newAppState, containsDifference];
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }
}

/**
 * Elements change is a low level primitive to capture a change between two sets of elements.
 * It does so by encapsulating forward and backward `Delta`s, which allow to travel in both directions.
 *
 * We could be smarter about the change in the future, ideas for improvements are:
 * - for memory, share the same delta instances between different deltas (flyweight-like)
 * - for serialization, compress the deltas into a tree-like structures with custom pointers or let one delta instance contain multiple element ids
 * - for performance, emit the changes directly by the user actions, then apply them in from store into the state (no diffing!)
 * - for performance, add operations in addition to deltas, which increment (decrement) properties by given value (could be used i.e. for presence-like move)
 */
export class ElementsChange implements Change<Map<string, ExcalidrawElement>> {
  private constructor(
    private readonly deltas: Map<string, Delta<ExcalidrawElement>>,
  ) {}

  public static create(deltas: Map<string, Delta<ExcalidrawElement>>) {
    return new ElementsChange(deltas);
  }

  /**
   * Calculates the `Delta`s between the previous and next set of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsChange` instance representing the `Delta` changes between the two sets of elements.
   */
  public static calculate<T extends ExcalidrawElement>(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
  ): ElementsChange {
    if (prevElements === nextElements) {
      return ElementsChange.empty();
    }

    const deltas = new Map<string, Delta<T>>();

    // TODO: this might be needed only in same edge cases, like during persist, when isDeleted elements are removed
    for (const [zIndex, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(prevElement.id);

      // Element got removed
      if (!nextElement) {
        const { id, ...partial } = prevElement;
        const from = { ...partial, isDeleted: false } as T;
        const to = { isDeleted: true } as T;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.clearIrrelevantProps,
        );

        deltas.set(prevElement.id, delta as Delta<T>);
      }
    }

    // TODO: try to find a workaround for zIndex
    for (const [zIndex, nextElement] of nextElements.entries()) {
      const prevElement = prevElements.get(nextElement.id);

      // Element got added
      if (!prevElement) {
        const { id, ...partial } = nextElement;
        const from = { isDeleted: true } as T;
        const to = { ...partial, isDeleted: false } as T;

        const delta = Delta.create(
          from,
          to,
          ElementsChange.clearIrrelevantProps,
        );

        deltas.set(nextElement.id, delta as Delta<T>);

        continue;
      }

      // Element got updated
      if (prevElement.versionNonce !== nextElement.versionNonce) {
        // O(n^2) here, but it's not as bad as it looks:
        // - we do this only on history recordings, not on every frame
        // - we do this only on changed elements
        // - # of element's properties is reasonably small
        // - otherwise we would have to emit deltas on user actions & apply them on every frame
        const delta = Delta.calculate<ExcalidrawElement>(
          prevElement,
          nextElement,
          ElementsChange.clearIrrelevantProps,
        );

        // Make sure there are at least some changes (except changes to irrelevant data)
        if (!Delta.isEmpty(delta)) {
          deltas.set(nextElement.id, delta as Delta<T>);
        }
      }
    }

    return new ElementsChange(deltas);
  }

  public static empty() {
    return new ElementsChange(new Map());
  }

  public inverse(): ElementsChange {
    const deltas = new Map<string, Delta<ExcalidrawElement>>();

    for (const [id, delta] of this.deltas.entries()) {
      deltas.set(id, Delta.create(delta.to, delta.from));
    }

    return new ElementsChange(deltas);
  }

  public applyTo(
    elements: Map<string, ExcalidrawElement>,
  ): [Map<string, ExcalidrawElement>, boolean] {
    let containsVisibleDifference = false;

    for (const [id, delta] of this.deltas.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        // Check if there was actually any visible change before applying
        if (!containsVisibleDifference) {
          if (existingElement.isDeleted !== !!delta.to.isDeleted) {
            // Special case, when delta (un)deletes alement, it results in a visible change
            containsVisibleDifference = true;
          } else if (!existingElement.isDeleted) {
            // Check for any difference on a visible element
            containsVisibleDifference = Delta.containsDifference(
              delta.to,
              existingElement,
            );
          }
        }

        elements.set(id, newElementWith(existingElement, delta.to, true));
      }
    }

    return [elements, containsVisibleDifference];
  }

  public isEmpty(): boolean {
    // TODO: might need to go through all deltas and check for emptiness
    return this.deltas.size === 0;
  }

  /**
   * Update the delta/s based on the existing elements.
   *
   * @param elements current elements
   * @param modifierOptions defines which of the delta (`from` or `to`) will be updated
   * @returns new instance with modified delta/s
   */
  public applyLatestChanges(
    elements: Map<string, ExcalidrawElement>,
  ): ElementsChange {
    const toBeModifiedPart = "to";
    const modifier =
      (element: ExcalidrawElement) => (partial: Partial<ExcalidrawElement>) => {
        const modifiedPartial: { [key: string]: unknown } = {};

        for (const key of Object.keys(partial)) {
          modifiedPartial[key] = element[key as keyof ExcalidrawElement];
        }

        return modifiedPartial;
      };

    const deltas = new Map<string, Delta<ExcalidrawElement>>();

    for (const [id, delta] of this.deltas.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        const modifiedDelta = Delta.create(
          delta.from,
          delta.to,
          modifier(existingElement),
          toBeModifiedPart,
        );

        deltas.set(id, modifiedDelta);
      } else {
        // Keep whatever we had
        deltas.set(id, delta);
      }
    }

    return ElementsChange.create(deltas);
  }

  private static clearIrrelevantProps(delta: Partial<ExcalidrawElement>) {
    const { updated, version, versionNonce, seed, ...clearedDelta } = delta;
    return clearedDelta;
  }
}
