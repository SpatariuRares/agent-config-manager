// Orca sidebar panel: the Claude Code setup, with plugins you can turn on and off.
import {
  Badge,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  Input,
  List,
  ListItem,
  read,
  Row,
  Select,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { Inventory } from '../../core/inventory.ts'
import { PluginsView } from './plugins-view.tsx'
import { answer, backups, busy, notice, query, refresh, restore, section } from './store.ts'

export function setup(_ctx: PanelContext): void {
  void refresh()
}

type Row = { key: string; title: string; description: string; badge?: string }

const MAX_DESCRIPTION = 160

function summary(text: string): string | undefined {
  if (text === '') return undefined
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text
}

function matches(row: Row, q: string): boolean {
  const needle = q.trim().toLowerCase()
  return needle === '' || `${row.title} ${row.description}`.toLowerCase().includes(needle)
}

function Rows({ rows, empty }: { rows: Row[]; empty: string }) {
  const visible = rows.filter((row) => matches(row, read(query)))
  if (visible.length === 0) return <EmptyState title={empty} />
  return (
    <List>
      {visible.map((row) => (
        <ListItem key={row.key} title={row.title} description={summary(row.description)}>
          {row.badge && <Badge>{row.badge}</Badge>}
        </ListItem>
      ))}
    </List>
  )
}

function sections(inv: Inventory) {
  const on = inv.plugins.filter((p) => p.enabled).length
  return [
    { value: 'plugins', label: `Plugins (${on}/${inv.plugins.length} on)` },
    { value: 'skills', label: `Skills (${inv.skills.length})` },
    { value: 'agents', label: `Agents (${inv.agents.length})` },
    { value: 'mcp', label: `MCP servers (${inv.mcpServers.length})` },
    { value: 'hooks', label: `Hooks (${inv.hooks.length})` }
  ]
}

function Section({ inv }: { inv: Inventory }) {
  switch (read(section)) {
    case 'skills':
      return <Rows empty="No skills" rows={inv.skills.map((s) => ({ key: s.path, title: s.name, description: s.description }))} />
    case 'agents':
      return <Rows empty="No agents" rows={inv.agents.map((a) => ({ key: a.path, title: a.name, description: a.description }))} />
    case 'mcp':
      return (
        <Rows
          empty="No MCP servers"
          rows={inv.mcpServers.map((m) => ({ key: m.name, title: m.name, description: m.target, badge: m.transport }))}
        />
      )
    case 'hooks':
      return (
        <Rows
          empty="No hooks"
          rows={inv.hooks.map((h, i) => ({ key: `${h.event}-${i}`, title: `${h.event} · ${h.matcher}`, description: h.command }))}
        />
      )
    default:
      return <PluginsView plugins={inv.plugins} />
  }
}

function NoticeBar() {
  const current = read(notice)
  if (current === null) return null
  return (
    <Callout tone={current.tone} title={current.title}>
      <Stack gap="xs">
        <Text size="sm">{current.text}</Text>
        <Row gap="xs">
          {current.undo && (
            <Button size="sm" variant="outline" disabled={read(busy) !== null} onPress={() => restore(current.undo!)}>
              Undo
            </Button>
          )}
          <Button size="sm" variant="ghost" onPress={() => set(notice, null)}>
            Dismiss
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function Backups() {
  const names = read(backups)
  return (
    <Collapsible title="Backups" description={`${names.length} in ~/.claude/backups/claude-config-manager`}>
      {names.length === 0 ? (
        <Text muted size="xs">A backup of settings.json is saved before every change.</Text>
      ) : (
        <List>
          {names.slice(0, 10).map((name) => (
            <ListItem key={name} title={name}>
              <Button size="sm" variant="ghost" disabled={read(busy) !== null} onPress={() => restore(name)}>
                Restore
              </Button>
            </ListItem>
          ))}
        </List>
      )}
    </Collapsible>
  )
}

export default function Panel() {
  const current = read(answer)
  if (current === null) return <Text muted>Reading ~/.claude...</Text>
  if (!current.ok) return <Callout tone="danger" title="Could not read the setup">{current.error}</Callout>

  const inv = current.inventory
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Claude Config</Heading>
        <Button variant="ghost" icon="refresh" disabled={read(busy) !== null} onPress={refresh}>
          Refresh
        </Button>
      </Row>
      <NoticeBar />
      {inv.problems.map((problem) => (
        <Callout key={problem} tone="warning" title="Unreadable file">{problem}</Callout>
      ))}
      <Select label="Section" labelHidden value={read(section)} options={sections(inv)} onChange={(v) => set(section, v)} />
      <Input label="Filter" labelHidden type="search" placeholder="Filter by name or contents" value={read(query)} onChange={(v) => set(query, v)} />
      <Section inv={inv} />
      <Backups />
    </Stack>
  )
}
