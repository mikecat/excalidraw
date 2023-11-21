import { Action, ActionResult } from "./types";
import { UndoIcon, RedoIcon } from "../components/icons";
import { ToolButton } from "../components/ToolButton";
import { t } from "../i18n";
import History, { HistoryEntry } from "../history";
import { ExcalidrawElement } from "../element/types";
import { AppState } from "../types";
import { KEYS } from "../keys";
import { newElementWith } from "../element/mutateElement";
import { fixBindingsAfterDeletion } from "../element/binding";
import { arrayToMap } from "../utils";
import { isWindows } from "../constants";

const writeData = (
  prevElements: readonly ExcalidrawElement[],
  appState: AppState,
  updater: () => HistoryEntry | null,
): ActionResult => {
  const commitToHistory = false;
  if (
    !appState.multiElement &&
    !appState.resizingElement &&
    !appState.editingElement &&
    !appState.draggingElement
  ) {
    const data = updater();
    if (data === null) {
      return { commitToHistory };
    }

    const prevElementMap = arrayToMap(prevElements);

    const updatedElements = prevElements.map((prevElement) => {
      const nextElement = data.deltaElements.get(prevElement.id);

      if (nextElement) {
        return newElementWith(prevElement, nextElement);
      }

      return prevElement;
    });
    
    const addedElements = Object.values(data.deltaElements).map((elementDelta) => {
      if (!prevElementMap.has(elementDelta.id)) {
        return newElementWith(elementDelta, elementDelta);
      }
    });

    const nextElements = updatedElements.concat(addedElements);

    const nextAppState = {
      ...appState,
      ...data.deltaAppState,
    };

    // const nextElementMap = arrayToMap(nextElements);

    // const deletedElements = prevElements.filter(
    //   (prevElement) => !nextElementMap.has(prevElement.id),
    // );
    // const elements = nextElements
    //   .map((nextElement) =>
    //     newElementWith(
    //       prevElementMap.get(nextElement.id) || nextElement,
    //       nextElement,
    //     ),
    //   )
    //   .concat(
    //     deletedElements.map((prevElement) =>
    //       newElementWith(prevElement, { isDeleted: true }),
    //     ),
    //   );
    // TODO: valid? probably yes
    // fixBindingsAfterDeletion(elements, deletedElements);

    return {
      elements: nextElements,
      appState: nextAppState,
      commitToHistory,
      syncHistory: true,
    };
  }
  return { commitToHistory };
};

type ActionCreator = (history: History) => Action;

export const createUndoAction: ActionCreator = (history) => ({
  name: "undo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(elements, appState, () => history.undoOnce()),
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] &&
    event.key.toLowerCase() === KEYS.Z &&
    !event.shiftKey,
  PanelComponent: ({ updateData, data }) => (
    <ToolButton
      type="button"
      icon={UndoIcon}
      aria-label={t("buttons.undo")}
      onClick={updateData}
      size={data?.size || "medium"}
    />
  ),
  commitToHistory: () => false,
});

export const createRedoAction: ActionCreator = (history) => ({
  name: "redo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(elements, appState, () => history.redoOnce()),
  keyTest: (event) =>
    (event[KEYS.CTRL_OR_CMD] &&
      event.shiftKey &&
      event.key.toLowerCase() === KEYS.Z) ||
    (isWindows && event.ctrlKey && !event.shiftKey && event.key === KEYS.Y),
  PanelComponent: ({ updateData, data }) => (
    <ToolButton
      type="button"
      icon={RedoIcon}
      aria-label={t("buttons.redo")}
      onClick={updateData}
      size={data?.size || "medium"}
    />
  ),
  commitToHistory: () => false,
});
