// The Orca transport of the panel contract in ../view.ts.
import type { ActionAnswer, ActionRequest, UpdatesAnswer, ViewAnswer } from '../view.ts'

declare module 'orca' {
  interface PluginRequests {
    /** Reads the whole setup, global and per project. */
    'view.get': { output: ViewAnswer }
    /** Runs one action (move, copy, remove, switch, uninstall, restore, snapshot). */
    'action.run': { input: ActionRequest; output: ActionAnswer }
    /** Checks every item with an UpdateSource for a newer version (network, on demand only). */
    'updates.check': { output: UpdatesAnswer }
  }
}
