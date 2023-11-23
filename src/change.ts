import { newElementWith } from "./element/mutateElement";
import { ExcalidrawElement } from "./element/types";

/**
 * Represents the difference between two `T` objects, enriched with a `string` accessor.
 */
type Delta<T> = {
  [K in keyof T]?: T[K];
} & { [key: string]: any };

/**
 * Encapsulates the modifications captured as `Delta`s.
 */
interface Change<T> {
  /**
   * Inverses the `Delta`s while creating a new `Change` instance.
   */
  inverse(): Change<T>;

  /**
   * Applies the `Change` to the previous state.
   */
  apply(previous: T): T;

  /**
   * Checks whether there are actually any `Delta`s in the `Change`.x`
   */
  isEmpty(): boolean;
}

/**
 * Represents a change made to an object, tracking additions, removals, and updates in its properties.
 */
export class ObjectChange<D extends Delta<D>> implements Change<D> {
  private constructor(
    private readonly added: D,
    private readonly removed: D,
    private readonly updated: {
      from: D;
      to: D;
    },
  ) {}

  /**
   * Calculates the changes between two objects and returns an ObjectChange instance.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns ObjectChange instance representing the deltas between `prevObject` and `nextObject`.
   */
  public static calculate<D extends Delta<D>>(
    prevObject: D,
    nextObject: D,
  ): ObjectChange<D> {
    if (prevObject === nextObject) {
      return ObjectChange.empty() as ObjectChange<D>;
    }

    const added = {} as D;
    const removed = {} as D;
    const updated = {
      from: {} as D,
      to: {} as D,
    };

    for (const [key, nextValue] of Object.entries(nextObject)) {
      if (!Object.hasOwnProperty.call(prevObject, key)) {
        added[key as keyof D] = nextValue;
        continue;
      }

      const prevValue = prevObject[key as keyof D];
      // TODO: worth shallow cloning objects?
      if (prevValue !== nextValue) {
        updated.from[key as keyof D] = prevValue;
        updated.to[key as keyof D] = nextValue;
      }
    }

    for (const [key, prevValue] of Object.entries(prevObject)) {
      if (!Object.hasOwnProperty.call(nextObject, key)) {
        removed[key as keyof D] = prevValue;
      }
    }

    return new ObjectChange(added, removed, updated);
  }

  private static empty() {
    return new ObjectChange({}, {}, { from: {}, to: {} });
  }

  public inverse(): ObjectChange<D> {
    const updated = {
      from: this.updated.to,
      to: this.updated.from,
    };

    return new ObjectChange(this.removed, this.added, updated);
  }

  public apply<T extends D>(prevObject: T): T {
    return {
      ...prevObject,
      ...this.added,
      ...this.updated.to,
    };
  }

  public isEmpty(): boolean {
    return (
      this.added.size === 0 &&
      this.removed.size === 0 &&
      this.updated.from.size === 0 &&
      this.updated.to.size === 0
    );
  }
}

export class ElementsChange<D extends Delta<ExcalidrawElement>>
  implements Change<Map<string, ExcalidrawElement>>
{
  private constructor(
    private readonly added: Map<string, ExcalidrawElement>,
    private readonly removed: Map<string, ExcalidrawElement>,
    private readonly updated: Map<string, { from: D; to: D }>,
  ) {}

  /**
   * Calculates the change between previous and next sets of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsChange` instance representing the delta changes between the two sets of elements.
   */
  public static calculate<D extends Delta<ExcalidrawElement>>(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
    deltaModifier?: (elementDelta: D) => D,
  ): ElementsChange<D> {
    if (prevElements === nextElements) {
      return ElementsChange.empty() as ElementsChange<D>;
    }

    const added = new Map<string, ExcalidrawElement>();
    const removed = new Map<string, ExcalidrawElement>();
    const updated = new Map<string, { from: D; to: D }>();

    // TODO: this might be needed only in same edge cases, like during persist, when isDeleted elements are removed
    for (const [zIndex, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        removed.set(prevElement.id, prevElement);
      }
    }

    // TODO: try to find a workaround for zIndex
    for (const [zIndex, nextElement] of nextElements.entries()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        added.set(nextElement.id, nextElement);
        continue;
      }

      if (prevElement.versionNonce !== nextElement.versionNonce) {
        const from = {} as D;
        const to = {} as D;

        const unionOfKeys = new Set([
          ...Object.keys(prevElement),
          ...Object.keys(nextElement),
        ]);

        // O(n^2) here, but it's not as bad as it looks:
        // - we do this only on history recordings, not on every frame
        // - we do this only on changed elements
        // - # of element's properties is reasonably small
        // - otherwise we would have to emit deltas on user actions & apply them on every frame
        for (const key of unionOfKeys) {
          const prevValue = prevElement[key as keyof ExcalidrawElement];
          const nextValue = nextElement[key as keyof ExcalidrawElement];

          if (prevValue !== nextValue) {
            from[key] = prevValue;
            to[key] = nextValue;
          }
        }

        if (Object.keys(from).length || Object.keys(to).length) {
          updated.set(nextElement.id, {
            from: deltaModifier ? deltaModifier(from) : from,
            to: deltaModifier ? deltaModifier(to) : to,
          });
        }
      }
    }

    return new ElementsChange(added, removed, updated);
  }

  private static empty() {
    return new ElementsChange(
      new Map<string, ExcalidrawElement>(),
      new Map<string, ExcalidrawElement>(),
      new Map<string, { from: {}; to: {} }>(),
    );
  }

  public inverse(): ElementsChange<D> {
    const added = new Map<string, ExcalidrawElement>();
    const removed = new Map<string, ExcalidrawElement>();
    const updated = new Map<string, { from: D; to: D }>();

    for (const [id, delta] of this.added.entries()) {
      removed.set(id, { ...delta, isDeleted: true });
    }

    for (const [id, delta] of this.removed.entries()) {
      added.set(id, { ...delta, isDeleted: false });
    }

    for (const [id, delta] of this.updated.entries()) {
      const { from, to } = delta;
      updated.set(id, { from: to, to: from });
    }

    return new ElementsChange(added, removed, updated);
  }

  public apply(
    elements: Map<string, ExcalidrawElement>,
  ): Map<string, ExcalidrawElement> {
    for (const [id, element] of this.removed.entries()) {
      elements.set(id, newElementWith(element, { isDeleted: true }));
    }

    for (const [id, element] of this.added.entries()) {
      elements.set(id, newElementWith(element, {}));
    }

    for (const [id, delta] of this.updated.entries()) {
      const element = elements.get(id);
      if (element) {
        const { to } = delta;

        elements.set(id, newElementWith(element, to));
      }
    }

    return elements;
  }

  public isEmpty(): boolean {
    return (
      this.added.size === 0 &&
      this.removed.size === 0 &&
      this.updated.size === 0
    );
  }
}

// TODO: Worth going shallow equal way?
// function __unsafe__isShallowEqual(prevValue: unknown, nextValue: unknown) {
//   if (typeof prevValue !== "object" && typeof nextValue !== "object") {
//     return true;
//   }

//   // Both are object but one of them is null, so they couldn't be shallow compared
//   if (nextObject[key] === null || nextValue === null) {
//     return true;
//   }

//   if (!isShallowEqual(prevValue, nextValue)) {
//     return true;
//   }
// }
