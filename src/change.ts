import { newElementWith } from "./element/mutateElement";
import { ExcalidrawElement } from "./element/types";
import { AppState } from "./types";

interface Change {
  /**
   * Inverses the change while creating a new instance
   */
  inverse(): Change;

  /**
   * Applies the change to the previous state
   */
  apply(previous: unknown): unknown; // TODO: fix type

  /**
   * Checks whether there are actually any changes
   */
  isEmpty(): boolean;
}

export class ElementsChange<
  T extends ExcalidrawElement["id"],
  V extends Partial<ExcalidrawElement>,
> implements Change
{
  private constructor(
    private readonly added: Map<T, ExcalidrawElement>,
    private readonly removed: Map<T, ExcalidrawElement>,
    private readonly updated: Map<T, { from: V; to: V }>,
  ) {}

  public static calculate(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
  ): ElementsChange<string, Partial<ExcalidrawElement>> {
    const added = new Map<string, ExcalidrawElement>();
    const removed = new Map<string, ExcalidrawElement>();
    const updated = new Map<
      string,
      { from: Partial<ExcalidrawElement>; to: Partial<ExcalidrawElement> }
    >();
    // TODO: might not be needed
    for (const [zIndex, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        removed.set(prevElement.id, prevElement);
      }
    }

    for (const [zIndex, nextElement] of nextElements.entries()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        added.set(nextElement.id, nextElement);
        continue;
      }

      if (prevElement.versionNonce !== nextElement.versionNonce) {
        const from: { [key: string]: unknown } = {}; // TODO: fix types
        const to: { [key: string]: unknown } = {};

        const unionOfKeys = new Set([
          ...Object.keys(prevElement),
          ...Object.keys(nextElement),
        ]);

        for (const key of unionOfKeys) {
          const prevValue = prevElement[key as keyof typeof prevElement];
          const nextValue = nextElement[key as keyof typeof nextElement];

          if (prevValue !== nextValue) {
            from[key] = prevValue;
            to[key] = nextValue;
          }
        }

        if (Object.keys(from).length || Object.keys(to).length) {
          updated.set(nextElement.id, { from, to });
        }
      }
    }

    return new ElementsChange(added, removed, updated);
  }

  public inverse(): ElementsChange<T, V> {
    // TODO: add type
    const added = new Map();
    const removed = new Map();
    const updated = new Map();

    for (const [id, delta] of this.removed.entries()) {
      added.set(id, { ...delta, isDeleted: false });
    }

    for (const [id, delta] of this.added.entries()) {
      removed.set(id, { ...delta, isDeleted: true });
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

type Delta<T> = {
  [K in keyof T]?: T[K];
} & { [key: string]: any };

export class AppStateChange<T extends Partial<AppState>> implements Change {
  private constructor(
    private readonly added: Delta<T>,
    private readonly removed: Delta<T>,
    private readonly updated: {
      from: Delta<T>;
      to: Delta<T>;
    },
  ) {}

  public static calculate<T extends Partial<AppState>>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateChange<T> {
    const added: Delta<T> = {};
    const removed: Delta<T> = {};
    const updated: {
      from: Delta<T>;
      to: Delta<T>;
    } = {
      from: {},
      to: {},
    };

    for (const [key, prevValue] of Object.entries(prevAppState)) {
      const nextValue = nextAppState[key as keyof typeof prevAppState];
      if (nextValue === undefined) {
        removed[key as keyof Delta<T>] = prevValue;
        continue;
      }

      if (prevValue !== nextValue) {
        updated.from[key as keyof Delta<T>] = prevValue;
        updated.to[key as keyof Delta<T>] = nextValue;
      }
    }

    for (const [key, nextValue] of Object.entries(nextAppState)) {
      const prevValue = prevAppState[key as keyof typeof nextAppState];
      if (prevValue === undefined) {
        added[key as keyof Delta<T>] = nextValue;
        continue;
      }

      if (prevValue !== nextValue) {
        updated.from[key as keyof Delta<T>] = prevValue;
        updated.to[key as keyof Delta<T>] = nextValue;
      }
    }

    return new AppStateChange(added, removed, updated);
  }

  public inverse(): AppStateChange<T> {
    const updated = {
      from: this.updated.to,
      to: this.updated.from,
    };

    return new AppStateChange(this.removed, this.added, updated);
  }

  public apply(appState: AppState): AppState {
    return {
      ...appState,
      ...this.added,
      ...this.updated.to,
    };
  }

  isEmpty(): boolean {
    return (
      this.added.size === 0 &&
      this.removed.size === 0 &&
      this.updated.from.size === 0 &&
      this.updated.to.size === 0
    );
  }
}

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
