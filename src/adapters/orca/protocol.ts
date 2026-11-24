// The panel <-> worker contract, declared once: panel.tsx and worker.ts both read it.
import type { Inventory } from '../../core/inventory.ts'

export type InventoryAnswer = { ok: true; inventory: Inventory } | { ok: false; error: string }

declare module 'orca' {
  interface PluginRequests {
    /** Reads the current Claude Code setup from disk. */
    'inventory.get': { output: InventoryAnswer }
  }
}
