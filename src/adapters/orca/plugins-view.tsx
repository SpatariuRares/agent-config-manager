// Plugins as cards in a grid, grouped by marketplace, each with its switch and what it contributes.
import { Badge, Card, Collapsible, EmptyState, Grid, Heading, read, Row, Stack, Switch, Text } from 'orca'
import type { Plugin, PluginContributions } from '../../core/inventory.ts'
import { busy, query, togglePlugin } from './store.ts'

const KINDS: { key: keyof PluginContributions; one: string; many: string }[] = [
  { key: 'skills', one: 'skill', many: 'skills' },
  { key: 'agents', one: 'agent', many: 'agents' },
  { key: 'commands', one: 'command', many: 'commands' },
  { key: 'hooks', one: 'hook', many: 'hooks' },
  { key: 'mcpServers', one: 'MCP server', many: 'MCP servers' }
]

function matches(plugin: Plugin, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (needle === '') return true
  const haystack = [plugin.id, ...Object.values(plugin.contributes).flat()].join(' ').toLowerCase()
  return haystack.includes(needle)
}

function PluginCard({ plugin }: { plugin: Plugin }) {
  const writing = read(busy)
  const kinds = KINDS.filter((kind) => plugin.contributes[kind.key].length > 0)
  return (
    <Card title={plugin.name} description={plugin.version ? `v${plugin.version}` : 'not installed'}>
      <Stack gap="sm">
        <Switch
          label={plugin.enabled ? 'Enabled' : 'Disabled'}
          checked={plugin.enabled}
          disabled={writing !== null}
          onChange={(on) => togglePlugin(plugin.id, on)}
        />
        <Row gap="xs" wrap>
          {kinds.length === 0 && <Text muted size="xs">Nothing to list (LSP or settings only)</Text>}
          {kinds.map((kind) => {
            const count = plugin.contributes[kind.key].length
            return <Badge key={kind.key}>{`${count} ${count === 1 ? kind.one : kind.many}`}</Badge>
          })}
        </Row>
        {plugin.sharesNameWith.length > 0 && (
          <Text tone="warning" size="xs">{`Also installed from ${plugin.sharesNameWith.map((id) => id.split('@')[1]).join(', ')}`}</Text>
        )}
        {kinds.length > 0 && (
          <Collapsible title="Contents">
            <Stack gap="xs">
              {kinds.map((kind) => (
                <Text key={kind.key} size="xs">
                  <Text weight="semibold" size="xs">{`${kind.many}: `}</Text>
                  {plugin.contributes[kind.key].join(', ')}
                </Text>
              ))}
            </Stack>
          </Collapsible>
        )}
      </Stack>
    </Card>
  )
}

export function PluginsView({ plugins }: { plugins: Plugin[] }) {
  const visible = plugins.filter((plugin) => matches(plugin, read(query)))
  if (visible.length === 0) return <EmptyState title="No plugins match" />
  const marketplaces = [...new Set(visible.map((plugin) => plugin.marketplace))].sort()
  return (
    <Stack gap="lg">
      {marketplaces.map((marketplace) => {
        const group = visible.filter((plugin) => plugin.marketplace === marketplace)
        const on = group.filter((plugin) => plugin.enabled).length
        return (
          <Stack key={marketplace} gap="sm">
            <Row justify="between">
              <Heading level={3}>{marketplace || 'no marketplace'}</Heading>
              <Text muted size="xs">{`${on}/${group.length} on`}</Text>
            </Row>
            <Grid minItemWidth="sm" gap="sm">
              {group.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin} />
              ))}
            </Grid>
          </Stack>
        )
      })}
    </Stack>
  )
}
