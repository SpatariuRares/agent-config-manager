// The Orca transport of the panel contract in ../view.ts.
import type { ActionAnswer, ActionRequest, AgentRequest, UpdatesAnswer, ViewAnswer } from '../view.ts'

declare module 'orca' {
  interface PluginRequests {
    /** Reads the whole setup, global and per project. */
    'view.get': { input: AgentRequest; output: ViewAnswer }
    /** Runs one action (move, copy, copy to another agent, remove, switch, uninstall, restore, snapshot). */
    'action.run': { input: ActionRequest; output: ActionAnswer }
    /** Checks every item with an UpdateSource for a newer version (network, on demand only). */
    'updates.check': { input: AgentRequest; output: UpdatesAnswer }
  }
}
