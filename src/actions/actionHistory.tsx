import { Action, ActionResult } from "./types";
import { UndoIcon, RedoIcon } from "../components/icons";
import { ToolButton } from "../components/ToolButton";
import { t } from "../i18n";
import { History } from "../history";
import { AppState } from "../types";
import { KEYS } from "../keys";
import { arrayToMap } from "../utils";
import { isWindows } from "../constants";
import { ExcalidrawElement } from "../element/types";
import { fixBindingsAfterDeletion } from "../element/binding";

const writeData = (
  appState: Readonly<AppState>,
  updater: () => [Map<string, ExcalidrawElement>, AppState] | void,
): ActionResult => {
  const commitToStore = false;
  if (
    !appState.multiElement &&
    !appState.resizingElement &&
    !appState.editingElement &&
    !appState.draggingElement
  ) {
    const result = updater();

    if (!result) {
      return { commitToStore };
    }

    // TODO_UNDO: worth detecting z-index deltas or do we just order based on fractional indices?
    const [nextElementsMap, nextAppState] = result;

    // TODO_UNDO: uncomment and test
    // fixBindingsAfterDeletion(elements, deletedElements);

    return {
      appState: nextAppState,
      elements: Array.from(nextElementsMap.values()),
      commitToStore,
      shouldOnlyUpdateSnapshot: true,
    };
  }
  return { commitToStore };
};

type ActionCreator = (history: History) => Action;

export const createUndoAction: ActionCreator = (history) => ({
  name: "undo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(appState, () => history.undo(arrayToMap(elements), appState)),
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
      disabled={history.isUndoStackEmpty}
    />
  ),
  commitToStore: () => false,
});

export const createRedoAction: ActionCreator = (history) => ({
  name: "redo",
  trackEvent: { category: "history" },
  perform: (elements, appState) =>
    writeData(appState, () => history.redo(arrayToMap(elements), appState)),
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
      disabled={history.isRedoStackEmpty}
    />
  ),
  commitToStore: () => false,
});
