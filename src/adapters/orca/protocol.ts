// The panel <-> worker contract, declared once: the panel files and worker.ts all read it.
import type { Inventory } from '../../core/inventory.ts'
import type { WriteResult } from '../../core/toggle.ts'

export type InventoryAnswer = { ok: true; inventory: Inventory } | { ok: false; error: string }

/** A write's outcome plus the inventory read right after it, so the panel never shows stale state. */
export type WriteAnswer = { result: WriteResult; inventory: InventoryAnswer }

declare module 'orca' {
  interface PluginRequests {
    /** Reads the current Claude Code setup from disk. */
    'inventory.get': { output: InventoryAnswer }
    /** Turns one plugin on or off in ~/.claude/settings.json, backing it up first. */
    'plugin.setEnabled': { input: { id: string; enabled: boolean; settingsVersion: string }; output: WriteAnswer }
    /** Backup file names, newest first. */
    'backups.list': { output: string[] }
    /** Puts one backup back as settings.json, backing up the current file first. */
    'backup.restore': { input: { name: string; settingsVersion: string }; output: WriteAnswer }
  }
}
