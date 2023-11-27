import { newElementWith } from "./element/mutateElement";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";

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

  public static create<T>(from: Partial<T>, to: Partial<T>) {
    return new Delta(from, to);
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

      // TODO: Worth going also shallow equal way?
      //  - it would mean O(n^3) so we would have to be careful
      if (prevValue !== nextValue) {
        from[key as keyof T] = prevValue;
        to[key as keyof T] = nextValue;
      }
    }
    return Delta.create(from, to);
  }

  public static empty() {
    return new Delta({}, {});
  }

  public static isEmpty<T>(delta: Delta<T>): boolean {
    return !Object.keys(delta.from).length && !Object.keys(delta.to).length;
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
   * Applies the `Change` to the previous state.
   */
  apply(previous: T): T;

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

  public apply(appState: AppState): AppState {
    return {
      ...appState,
      ...this.delta.to,
    };
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }
}

export class ElementsChange implements Change<Map<string, ExcalidrawElement>> {
  private constructor(
    // TODO: consider being smarter here and squash the same deltas
    private readonly deltas: Map<string, Delta<ExcalidrawElement>>,
  ) {}

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

        const delta = Delta.create<T>(from, to);
        deltas.set(prevElement.id, delta);
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

        const delta = Delta.create<T>(from, to);
        deltas.set(nextElement.id, delta);

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
        );

        const clearedDelta = Delta.create<ExcalidrawElement>(
          ElementsChange.clearIrrelevantProps(delta.from),
          ElementsChange.clearIrrelevantProps(delta.to),
        );

        // Make sure there are at least some changes (except changes to irrelevant data)
        if (!Delta.isEmpty(clearedDelta)) {
          // TODO: Could shallow equal here instead of going shallow equal rabbit hole, but better to fix it at the root
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

  public apply(
    elements: Map<string, ExcalidrawElement>,
  ): Map<string, ExcalidrawElement> {
    for (const [id, delta] of this.deltas.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        // Make sure to remove irrelevant props when applying the delta
        const to = ElementsChange.clearIrrelevantProps(delta.to);

        elements.set(id, newElementWith(existingElement, to, true));
      }
    }

    return elements;
  }

  public isEmpty(): boolean {
    // TODO: might need to go through all deltas and check for emptiness
    return this.deltas.size === 0;
  }

  private static clearIrrelevantProps(delta: Partial<ExcalidrawElement>) {
    const { updated, version, versionNonce, ...clearedDelta } = delta;
    return clearedDelta;
  }
}
