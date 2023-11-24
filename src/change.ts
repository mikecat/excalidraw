import { newElementWith } from "./element/mutateElement";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";

/**
 * Represents the difference between two `T` objects, enriched with a `string` accessor.
 */
type Delta<T> = Partial<T> & { [key: string]: any };

/**
 * Represents a change made to an object, encapsulating both `from` and `before` deltas.
 * Keeping it as pure object (without transient state, side-effects, etc.), so we don't have to instantiate it on load.
 */
class Change<T> {
  private constructor(
    public readonly from: Delta<T>,
    public readonly to: Delta<T>,
  ) {}

  public static create<T>(
    from: Delta<T>,
    to: Delta<T>,
    deltaModifier?: (elementDelta: Delta<T>) => Delta<T>,
  ) {
    const nextFrom = deltaModifier ? deltaModifier(from) : from;
    const nextTo = deltaModifier ? deltaModifier(to) : to;

    return new Change(nextFrom, nextTo);
  }

  /**
   * Calculates the changes between two objects and returns an Change instance.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns Change instance encapsulating the deltas between `prevObject` and `nextObject`.
   */
  public static calculate<T extends Object>(
    prevObject: T,
    nextObject: T,
    deltaModifier?: (elementDelta: Delta<T>) => Delta<T>,
  ): Change<T> {
    if (prevObject === nextObject) {
      return Change.empty();
    }

    const from = {} as Delta<T>;
    const to = {} as Delta<T>;

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
    return Change.create(from, to, deltaModifier);
  }

  private static empty() {
    return new Change({}, {});
  }

  public static isEmpty<T>(change: Change<T>): boolean {
    return !Object.keys(change.from).length && !Object.keys(change.to).length;
  }
}

// TODO: I also might need clone (with modifier)
/**
 * Encapsulates the modifications captured as `Change`/s.
 */
interface Increment<T> {
  /**
   * Inverses the `Delta`s while creating a new `Change` instance.
   */
  inverse(): Increment<T>;

  /**
   * Applies the `Change` to the previous state.
   */
  apply(previous: T): T;

  /**
   * Checks whether there are actually any `Delta`s in the `Change`.x`
   */
  isEmpty(): boolean;
}

export class AppStateIncrement implements Increment<AppState> {
  private constructor(private readonly change: Change<AppState>) {}

  public static calculate<T extends Delta<AppState>>(
    prevObject: T,
    nextObject: T,
    deltaModifier?: (elementDelta: Delta<T>) => Delta<T>,
  ): AppStateIncrement {
    const change = Change.calculate(prevObject, nextObject, deltaModifier);
    return new AppStateIncrement(change);
  }

  public inverse(): AppStateIncrement {
    const inversedChange = Change.create(this.change.to, this.change.from);
    return new AppStateIncrement(inversedChange);
  }

  public apply(appState: AppState): AppState {
    return {
      ...appState,
      ...this.change.to,
    };
  }

  public isEmpty(): boolean {
    return Change.isEmpty(this.change);
  }
}

export class ElementsIncrement
  implements Increment<Map<string, ExcalidrawElement>>
{
  private constructor(
    private readonly changes: Map<string, Change<ExcalidrawElement>>,
  ) {}

  /**
   * Calculates the change between previous and next sets of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsChange` instance representing the delta changes between the two sets of elements.
   */
  public static calculate<T extends ExcalidrawElement>(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
    deltaModifier?: (elementDelta: Delta<T>) => Delta<T>,
  ): ElementsIncrement {
    if (prevElements === nextElements) {
      return ElementsIncrement.empty();
    }

    const changes = new Map<string, Change<T>>();

    // TODO: this might be needed only in same edge cases, like during persist, when isDeleted elements are removed
    for (const [zIndex, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(prevElement.id);

      // Element got removed
      if (!nextElement) {
        const { id, ...delta } = prevElement;
        const from = { ...delta, isDeleted: false } as T;
        const to = { isDeleted: true } as T;

        const change = Change.create(from, to, deltaModifier);
        changes.set(prevElement.id, change);
      }
    }

    // TODO: try to find a workaround for zIndex
    for (const [zIndex, nextElement] of nextElements.entries()) {
      const prevElement = prevElements.get(nextElement.id);

      // Element got added
      if (!prevElement) {
        const { id, ...delta } = nextElement;
        const from = { isDeleted: true } as T;
        const to = { ...delta, isDeleted: false } as T;

        const change = Change.create(from, to, deltaModifier);
        changes.set(nextElement.id, change);

        continue;
      }

      // Element got updated
      if (prevElement.versionNonce !== nextElement.versionNonce) {
        // O(n^2) here, but it's not as bad as it looks:
        // - we do this only on history recordings, not on every frame
        // - we do this only on changed elements
        // - # of element's properties is reasonably small
        // - otherwise we would have to emit deltas on user actions & apply them on every frame
        const change = Change.calculate(
          prevElement,
          nextElement,
          deltaModifier as (elementDelta: Delta<ExcalidrawElement>) => T, // TODO: recheck this type, it's weird
        );

        if (!Change.isEmpty(change)) {
          // TODO: Could shallow equal here instead of going shallow equal rabit whole
          changes.set(nextElement.id, change as Change<T>);
        }
      }
    }

    return new ElementsIncrement(changes);
  }

  private static empty() {
    return new ElementsIncrement(new Map());
  }

  public inverse(): ElementsIncrement {
    const changes = new Map<string, Change<ExcalidrawElement>>();

    for (const [id, change] of this.changes.entries()) {
      changes.set(id, Change.create(change.to, change.from));
    }

    return new ElementsIncrement(changes);
  }

  public apply(
    elements: Map<string, ExcalidrawElement>,
  ): Map<string, ExcalidrawElement> {
    for (const [id, change] of this.changes.entries()) {
      const existingElement = elements.get(id);

      if (existingElement) {
        const { to } = change;

        elements.set(id, newElementWith(existingElement, to, true));
      }
    }

    return elements;
  }

  public isEmpty(): boolean {
    // TODO: might need to go through all changes and check
    return this.changes.size === 0;
  }
}
