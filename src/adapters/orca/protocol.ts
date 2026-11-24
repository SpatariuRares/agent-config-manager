// The panel <-> worker contract, declared once: the panel files and worker.ts all read it.
import type { Inventory } from '../../core/inventory.ts'
import type { ProjectPluginChange, WriteResult } from '../../core/toggle.ts'
import type { UninstallResult } from '../../core/uninstall.ts'

export type InventoryAnswer = { ok: true; inventory: Inventory } | { ok: false; error: string }

/** A write's outcome plus the inventory read right after it, so the panel never shows stale state. */
export type WriteAnswer = { result: WriteResult; inventory: InventoryAnswer }
export type UninstallAnswer = { result: UninstallResult; inventory: InventoryAnswer }

/** A backup file and the settings file it restores. */
export type BackupEntry = { name: string; target: string }

declare module 'orca' {
  interface PluginRequests {
    /** Reads the current Claude Code setup from disk. */
    'inventory.get': { output: InventoryAnswer }
    /** Turns one plugin on or off in ~/.claude/settings.json, backing it up first. */
    'plugin.setEnabled': { input: { id: string; enabled: boolean; settingsVersion: string }; output: WriteAnswer }
    /** Sets or clears one plugin in a project's settings file, backing it up first. */
    'plugin.setProjectState': { input: ProjectPluginChange; output: WriteAnswer }
    /** Uninstalls a plugin from every scope through the claude CLI, keeping its data. */
    'plugin.uninstall': { input: { id: string }; output: UninstallAnswer }
    /** Backups, newest first. */
    'backups.list': { output: BackupEntry[] }
    /** Puts one backup back in place of its file, backing up the current file first. */
    'backup.restore': { input: { name: string; settingsVersion: string }; output: WriteAnswer }
  }
}
