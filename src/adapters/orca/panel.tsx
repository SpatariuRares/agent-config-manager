// Orca sidebar panel: a read-only view of the Claude Code setup.
import {
  atom,
  Badge,
  Button,
  Callout,
  EmptyState,
  Heading,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { InventoryAnswer } from './protocol.ts'

const answer = atom<InventoryAnswer | null>(null)
const query = atom('query', '')
const tab = atom('tab', 'plugins', { persist: 'plugin' })

async function refresh(): Promise<void> {
  set(answer, await plugin.request('inventory.get'))
}

export function setup(_ctx: PanelContext): void {
  void refresh()
}

type Row = { key: string; title: string; description: string; badge?: string; off?: boolean }

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
          {row.badge && <Badge tone={row.off ? 'neutral' : 'success'}>{row.badge}</Badge>}
        </ListItem>
      ))}
    </List>
  )
}

export default function Panel() {
  const current = read(answer)
  if (current === null) return <Text muted>Reading ~/.claude...</Text>
  if (!current.ok) return <Callout tone="danger" title="Could not read the setup">{current.error}</Callout>

  const inv = current.inventory
  const pluginsOff = inv.plugins.filter((p) => !p.enabled).length
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Claude Config</Heading>
        <Button variant="ghost" onPress={refresh}>Refresh</Button>
      </Row>
      {inv.problems.map((problem) => (
        <Callout key={problem} tone="warning" title="Unreadable file">{problem}</Callout>
      ))}
      <Input label="Filter" labelHidden type="search" placeholder="Filter by name or description" value={read(query)} onChange={(v) => set(query, v)} />
      <Tabs label="Sections" value={read(tab)} onChange={(v) => set(tab, v)}>
        <Tab value="plugins" label={`Plugins ${inv.plugins.length - pluginsOff}/${inv.plugins.length}`}>
          <Rows
            empty="No plugins"
            rows={inv.plugins.map((p) => ({ key: p.id, title: p.name, description: p.marketplace, badge: p.enabled ? 'on' : 'off', off: !p.enabled }))}
          />
        </Tab>
        <Tab value="skills" label={`Skills ${inv.skills.length}`}>
          <Rows empty="No skills" rows={inv.skills.map((s) => ({ key: s.path, title: s.name, description: s.description }))} />
        </Tab>
        <Tab value="agents" label={`Agents ${inv.agents.length}`}>
          <Rows empty="No agents" rows={inv.agents.map((a) => ({ key: a.path, title: a.name, description: a.description }))} />
        </Tab>
        <Tab value="mcp" label={`MCP ${inv.mcpServers.length}`}>
          <Rows empty="No MCP servers" rows={inv.mcpServers.map((m) => ({ key: m.name, title: m.name, description: m.target, badge: m.transport }))} />
        </Tab>
        <Tab value="hooks" label={`Hooks ${inv.hooks.length}`}>
          <Rows
            empty="No hooks"
            rows={inv.hooks.map((h, i) => ({ key: `${h.event}-${i}`, title: `${h.event} · ${h.matcher}`, description: h.command }))}
          />
        </Tab>
      </Tabs>
    </Stack>
  )
}
